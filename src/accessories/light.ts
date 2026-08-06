import type { API, Logging, PlatformAccessory, Service } from 'homebridge'
import { errorMessage } from '../protect/errors.js'

/**
 * Writes a Protect Light makes back to the console. `on` maps to
 * `isLightForceEnabled` — a force-on/off override that leaves the light's
 * configured mode (motion/always/off) untouched — and `level` to the hardware
 * `ledLevel`. The platform supplies these so this module never needs the client.
 */
export interface LightCallbacks {
  setOn: (deviceId: string, on: boolean) => Promise<void>
  setBrightness: (deviceId: string, level: number) => Promise<void>
}

/** Stable subtype for the light's downward Motion sensor service. */
const MOTION_SUBTYPE = 'light-motion'

/** Protect's `ledLevel` is a 1-6 step; HomeKit Brightness is a 0-100 percent. */
export const LED_LEVEL_MIN = 1
export const LED_LEVEL_MAX = 6

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/** A `ledLevel` (1-6) as the nearest HomeKit Brightness percentage. */
export function ledLevelToPercent(level: number): number {
  const clamped = Math.min(LED_LEVEL_MAX, Math.max(LED_LEVEL_MIN, Math.round(level)))
  return Math.round((clamped / LED_LEVEL_MAX) * 100)
}

/** A HomeKit Brightness percentage as the nearest `ledLevel` (1-6). */
export function percentToLedLevel(percent: number): number {
  const level = Math.round((percent / 100) * LED_LEVEL_MAX)
  return Math.min(LED_LEVEL_MAX, Math.max(LED_LEVEL_MIN, level))
}

/**
 * Whether an absent light field means the console reported it that way or the
 * payload could not be understood.
 *
 * `lightSchema` makes both fields required, but `ProtectClient.validate` returns
 * the RAW payload when validation fails, so a Ubiquiti field rename delivers a
 * light with neither. The same floor `camera.ts` applies: act on a payload you
 * understood, never write a SerialNumber from a degraded one — a changed serial
 * makes HomeKit treat this as a different accessory.
 */
export function isUnderstoodLight(device: Record<string, unknown>): boolean {
  return typeof device.isLightOn === 'boolean' && isRecord(device.lightDeviceSettings)
}

/**
 * HomeKit rejects a name over 64 characters, and the name comes from the
 * console, so it is not length-bounded. Truncate rather than let HAP warn on
 * every discovery.
 */
function deviceLabel(device: Record<string, unknown>): string {
  const name = typeof device.name === 'string' ? device.name.trim() : ''
  return name ? name.slice(0, 48) : 'Light'
}

/**
 * Builds the HomeKit services for a Protect Light: a Lightbulb (on/off plus
 * brightness) and a Motion sensor driven by its PIR. Idempotent — a later
 * discovery or a `deviceUpdate` frame re-runs it to push new state, exactly as
 * `platform.ts` does for cameras.
 */
export function buildLightServices(
  api: API,
  log: Logging,
  accessory: PlatformAccessory,
  device: Record<string, unknown>,
  callbacks: LightCallbacks,
): void {
  const { Characteristic: C, Service: S } = api.hap
  const label = deviceLabel(device)

  const info = accessory.getService(S.AccessoryInformation) ?? accessory.addService(S.AccessoryInformation)
  // Only from a payload we understood — see `isUnderstoodLight`.
  if (isUnderstoodLight(device)) {
    info.setCharacteristic(C.Manufacturer, 'Ubiquiti')
      .setCharacteristic(C.Model, typeof device.modelKey === 'string' ? device.modelKey : 'light')
      .setCharacteristic(C.SerialNumber, typeof device.mac === 'string' ? device.mac : String(device.id ?? 'unknown'))
  }

  let bulb = accessory.getServiceById(S.Lightbulb, 'light')
  if (!bulb) {
    // The name is written once, here — writing it on every discovery would
    // overwrite whatever the user renamed the service to in Home.app.
    bulb = accessory.addService(S.Lightbulb, label, 'light')
    log.debug(`Added light service to "${label}".`)
  }
  wireOnOff(api, log, bulb, device, label, callbacks)
  wireBrightness(api, log, bulb, device, label, callbacks)

  let motion = accessory.getServiceById(S.MotionSensor, MOTION_SUBTYPE)
  if (!motion) {
    motion = accessory.addService(S.MotionSensor, `${label} Motion`, MOTION_SUBTYPE)
    log.debug(`Added motion service to "${label}".`)
  }
  motion.updateCharacteristic(C.MotionDetected, device.isPirMotionDetected === true)
}

function wireOnOff(
  api: API,
  log: Logging,
  service: Service,
  device: Record<string, unknown>,
  label: string,
  callbacks: LightCallbacks,
): void {
  const { Characteristic: C } = api.hap
  // Reflects the ACTUAL LED state, not the force-enable flag: a light on via
  // motion should read on in HomeKit.
  service.updateCharacteristic(C.On, device.isLightOn === true)

  const characteristic = service.getCharacteristic(C.On)
  // `removeOnSet`, not `removeAllListeners`: hap-nodejs keeps a single set
  // handler, so an explicit clear before re-wiring is the only safe rebuild.
  characteristic.removeOnSet()
  characteristic.onSet(async (value) => {
    try {
      await callbacks.setOn(String(device.id), Boolean(value))
    }
    catch (error) {
      // errorMessage, never the error object: it carries request context that
      // util.inspect has printed the API key from before.
      log.warn(`Could not switch the light "${label}": ${errorMessage(error)}`)
      // Throw so HomeKit reverts the switch — a normal return tells HAP the
      // write succeeded and it commits the value the console rejected.
      throw new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
  })
}

function wireBrightness(
  api: API,
  log: Logging,
  service: Service,
  device: Record<string, unknown>,
  label: string,
  callbacks: LightCallbacks,
): void {
  const { Characteristic: C } = api.hap
  const settings = record(device.lightDeviceSettings)
  if (typeof settings.ledLevel === 'number')
    service.updateCharacteristic(C.Brightness, ledLevelToPercent(settings.ledLevel))

  const characteristic = service.getCharacteristic(C.Brightness)
  characteristic.removeOnSet()
  characteristic.onSet(async (value) => {
    try {
      await callbacks.setBrightness(String(device.id), percentToLedLevel(Number(value)))
    }
    catch (error) {
      log.warn(`Could not set the brightness on "${label}": ${errorMessage(error)}`)
      throw new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
  })
}
