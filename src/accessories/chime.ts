import type { API, Logging, PlatformAccessory, Service } from 'homebridge'
import { errorMessage } from '../protect/errors.js'

/**
 * The write a chime volume control makes back to the console. `volume` is the
 * 0-100 loudness applied to every doorbell this chime is paired to; the
 * platform preserves each ring's other fields (`ringtoneId`, `repeatTimes`).
 */
export interface ChimeCallbacks {
  setVolume: (deviceId: string, volume: number) => Promise<void>
}

/** Stable subtype for the chime's volume Lightbulb. */
const VOLUME_SUBTYPE = 'chime-volume'

/** HomeKit has no chime accessory; a Lightbulb turns to full when switched on. */
const FULL_VOLUME = 100

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The chime's loudness as a single 0-100 value: the maximum across every paired
 * doorbell's ring setting, so the tile reads on whenever any doorbell is
 * audible. Absent or malformed ring settings read as silent.
 */
export function chimeVolume(device: Record<string, unknown>): number {
  const rings = Array.isArray(device.ringSettings) ? device.ringSettings : []
  let volume = 0
  for (const ring of rings) {
    const value = isRecord(ring) ? ring.volume : undefined
    if (typeof value === 'number' && value > volume)
      volume = value
  }
  return Math.min(FULL_VOLUME, Math.max(0, Math.round(volume)))
}

/**
 * Whether the payload carries the ring settings this module reads. `chimeSchema`
 * makes `ringSettings` required, but `ProtectClient.validate` returns the raw
 * payload when validation fails, so a Ubiquiti field rename delivers a chime
 * without it — the same floor `camera.ts` applies before writing a SerialNumber.
 */
export function isUnderstoodChime(device: Record<string, unknown>): boolean {
  return Array.isArray(device.ringSettings)
}

/**
 * HomeKit rejects a name over 64 characters, and the name comes from the
 * console. Truncate rather than let HAP warn on every discovery.
 */
function deviceLabel(device: Record<string, unknown>): string {
  const name = typeof device.name === 'string' ? device.name.trim() : ''
  return name ? name.slice(0, 48) : 'Chime'
}

/**
 * Exposes a Protect chime as a HomeKit Lightbulb whose brightness is the ring
 * volume. Idempotent — a later discovery or a `deviceUpdate` frame re-runs it to
 * push new state, exactly as `platform.ts` does for cameras and lights.
 */
export function buildChimeServices(
  api: API,
  log: Logging,
  accessory: PlatformAccessory,
  device: Record<string, unknown>,
  callbacks: ChimeCallbacks,
): void {
  const { Characteristic: C, Service: S } = api.hap
  const label = deviceLabel(device)

  const info = accessory.getService(S.AccessoryInformation) ?? accessory.addService(S.AccessoryInformation)
  // Only from a payload we understood — see `isUnderstoodChime`.
  if (isUnderstoodChime(device)) {
    info.setCharacteristic(C.Manufacturer, 'Ubiquiti')
      .setCharacteristic(C.Model, typeof device.modelKey === 'string' ? device.modelKey : 'chime')
      .setCharacteristic(C.SerialNumber, typeof device.mac === 'string' ? device.mac : String(device.id ?? 'unknown'))
  }

  let bulb = accessory.getServiceById(S.Lightbulb, VOLUME_SUBTYPE)
  if (!bulb) {
    // The name is written once, here — a rewrite on every discovery would
    // overwrite whatever the user renamed the tile to in Home.app.
    bulb = accessory.addService(S.Lightbulb, `${label} Volume`, VOLUME_SUBTYPE)
    log.debug(`Added chime volume service to "${label}".`)
  }
  wireVolume(api, log, bulb, device, label, callbacks)
}

function wireVolume(
  api: API,
  log: Logging,
  service: Service,
  device: Record<string, unknown>,
  label: string,
  callbacks: ChimeCallbacks,
): void {
  const { Characteristic: C } = api.hap
  // Local state, not a re-read of the build-time payload: a brightness change
  // does not rebuild the service, so the closure's `device` is stale by the
  // time the user toggles off then on. `lastAudible` is what "on" restores,
  // exactly as a HomeKit Lightbulb keeps its brightness across an off/on.
  let volume = chimeVolume(device)
  let lastAudible = volume > 0 ? volume : FULL_VOLUME
  service.updateCharacteristic(C.On, volume > 0)
  service.updateCharacteristic(C.Brightness, volume)

  const apply = async (target: number): Promise<void> => {
    await callbacks.setVolume(String(device.id), target)
    volume = target
    if (target > 0)
      lastAudible = target
    service.updateCharacteristic(C.On, target > 0)
    service.updateCharacteristic(C.Brightness, target)
  }

  const on = service.getCharacteristic(C.On)
  on.removeOnSet()
  on.onSet(async (value) => {
    // Off silences; on restores the last audible level so the toggle is never
    // inert and never forgets where the volume was.
    const target = value ? lastAudible : 0
    try {
      await apply(target)
    }
    catch (error) {
      // errorMessage, never the error object: it carries request context that
      // util.inspect has printed the API key from before.
      log.warn(`Could not change the volume on "${label}": ${errorMessage(error)}`)
      throw new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
  })

  const brightness = service.getCharacteristic(C.Brightness)
  brightness.removeOnSet()
  brightness.onSet(async (value) => {
    try {
      await apply(Math.min(FULL_VOLUME, Math.max(0, Math.round(Number(value)))))
    }
    catch (error) {
      log.warn(`Could not change the volume on "${label}": ${errorMessage(error)}`)
      throw new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
  })
}
