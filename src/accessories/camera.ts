import type { API, Logging, PlatformAccessory, Service } from 'homebridge'

/**
 * What the tracker hands to `applyChange`. Declared here because Task 3 lands
 * before the tracker; `src/accessories/tracker.ts` should import this rather
 * than redeclare it. Only these two fields are read, so a richer tracker type
 * carrying an event id or device id assigns straight in.
 */
export interface SensorChange {
  subtype: string
  active: boolean
}

/** Labels shown in Home.app, one per stable subtype. */
export const SUBTYPE_LABELS: Record<string, string> = {
  'motion': 'Motion',
  'detect-person': 'Person',
  'detect-vehicle': 'Vehicle',
  'detect-animal': 'Animal',
  'detect-package': 'Package',
  'detect-licensePlate': 'License Plate',
  'detect-face': 'Face',
  'audio-alrmSmoke': 'Smoke Alarm',
  'audio-alrmCmonx': 'CO Alarm',
  'ring': 'Doorbell',
}

/** Audio detections that have a native HomeKit service. */
const AUDIO_SERVICE = new Set(['audio-alrmSmoke', 'audio-alrmCmonx'])

export interface CameraCallbacks {
  setLed: (deviceId: string, on: boolean) => Promise<void>
}

/**
 * A degraded payload is returned raw when Zod validation fails, so a field the
 * type says exists may be absent at runtime. Every read here tolerates that.
 */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** The subtypes this device should expose, given what is enabled in Protect. */
export function desiredSubtypes(device: Record<string, unknown>): string[] {
  const settings = record(device.smartDetectSettings)
  const flags = record(device.featureFlags)
  const out = ['motion']

  for (const type of stringArray(settings.objectTypes)) {
    const subtype = `detect-${type}`
    // Only types with a label are exposed; an unknown type from a firmware
    // update is ignored rather than producing an unnamed service.
    if (SUBTYPE_LABELS[subtype] && !out.includes(subtype))
      out.push(subtype)
  }
  for (const type of stringArray(settings.audioTypes)) {
    const subtype = `audio-${type}`
    if (AUDIO_SERVICE.has(subtype) && !out.includes(subtype))
      out.push(subtype)
  }
  // Only a doorbell has a speaker on this hardware; a ring event cannot arrive
  // from a camera without one.
  if (flags.hasSpeaker === true)
    out.push('ring')
  if (flags.hasLedStatus === true)
    out.push('led')

  return out
}

function serviceTypeFor(api: API, subtype: string) {
  const { Service: S } = api.hap
  if (subtype === 'ring')
    return S.Doorbell
  if (subtype === 'led')
    return S.Switch
  if (subtype === 'audio-alrmSmoke')
    return S.SmokeSensor
  if (subtype === 'audio-alrmCmonx')
    return S.CarbonMonoxideSensor
  return S.MotionSensor
}

/**
 * HomeKit rejects a name over 64 characters, and the device name comes from
 * the console, so it is not length-bounded. Truncate rather than let HAP warn
 * on every discovery. 48 leaves room for the longest suffix, " License Plate".
 */
function deviceLabel(device: Record<string, unknown>): string {
  const name = typeof device.name === 'string' ? device.name.trim() : ''
  return name ? name.slice(0, 48) : 'Camera'
}

export function buildCameraServices(
  api: API,
  log: Logging,
  accessory: PlatformAccessory,
  device: Record<string, unknown>,
  callbacks: CameraCallbacks,
): void {
  const { Characteristic: C, Service: S } = api.hap
  const label = deviceLabel(device)

  const info = accessory.getService(S.AccessoryInformation) ?? accessory.addService(S.AccessoryInformation)
  info.setCharacteristic(C.Manufacturer, 'Ubiquiti')
    .setCharacteristic(C.Model, typeof device.modelKey === 'string' ? device.modelKey : 'camera')
    .setCharacteristic(C.SerialNumber, typeof device.mac === 'string' ? device.mac : String(device.id ?? 'unknown'))

  const desired = desiredSubtypes(device)

  for (const subtype of desired) {
    const type = serviceTypeFor(api, subtype)
    const name = subtype === 'led' ? `${label} Status LED` : `${label} ${SUBTYPE_LABELS[subtype]}`
    let service = accessory.getServiceById(type, subtype)
    if (!service) {
      service = accessory.addService(type, name, subtype)
      log.debug(`Added ${subtype} service to "${label}".`)
    }
    service.setCharacteristic(C.ConfiguredName, name)

    if (subtype === 'led')
      wireLed(api, log, service, device, label, callbacks)
  }

  // Removal is destructive, so it runs only from a confirmed successful
  // discovery — the caller in platform.ts guarantees that.
  for (const service of [...accessory.services]) {
    const subtype = service.subtype
    if (!subtype || desired.includes(subtype))
      continue
    accessory.removeService(service)
    log.info(`Removed ${subtype} from "${label}" — no longer enabled in Protect.`)
  }
}

function wireLed(
  api: API,
  log: Logging,
  service: Service,
  device: Record<string, unknown>,
  label: string,
  callbacks: CameraCallbacks,
): void {
  const { Characteristic: C } = api.hap
  service.updateCharacteristic(C.On, record(device.ledSettings).isEnabled === true)

  const characteristic = service.getCharacteristic(C.On)
  // Re-registering would stack handlers on every rebuild.
  characteristic.removeAllListeners('set')
  characteristic.onSet(async (value) => {
    try {
      await callbacks.setLed(String(device.id), Boolean(value))
    }
    catch (error) {
      // Only the message is logged: the error object carries request context
      // and util.inspect on it — which is what log.error(err) uses — would
      // print the API key.
      log.warn(`Could not change the status LED on "${label}": ${(error as Error).message}`)
      // Must throw, not swallow. A handler that returns normally tells HAP the
      // write succeeded and HAP then commits the new value, so reverting the
      // characteristic in here would simply be overwritten. Throwing is what
      // makes HomeKit put the switch back.
      throw new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
  })
}

export function applyChange(api: API, accessory: PlatformAccessory, change: SensorChange): void {
  const { Characteristic: C } = api.hap
  const type = serviceTypeFor(api, change.subtype)
  const service: Service | undefined = accessory.getServiceById(type, change.subtype)
  if (!service)
    return

  if (change.subtype === 'ring') {
    // Stateless: a ring fires once and has nothing to clear.
    if (change.active)
      service.updateCharacteristic(C.ProgrammableSwitchEvent, C.ProgrammableSwitchEvent.SINGLE_PRESS)
    return
  }
  if (change.subtype === 'audio-alrmSmoke') {
    service.updateCharacteristic(C.SmokeDetected, change.active ? C.SmokeDetected.SMOKE_DETECTED : C.SmokeDetected.SMOKE_NOT_DETECTED)
    return
  }
  if (change.subtype === 'audio-alrmCmonx') {
    service.updateCharacteristic(C.CarbonMonoxideDetected, change.active ? C.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL : C.CarbonMonoxideDetected.CO_LEVELS_NORMAL)
    return
  }
  service.updateCharacteristic(C.MotionDetected, change.active)
}
