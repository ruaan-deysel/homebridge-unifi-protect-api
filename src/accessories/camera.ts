import type { API, Logging, PlatformAccessory, Service } from 'homebridge'
import type { SensorChange } from './tracker.js'
import { errorMessage } from '../protect/errors.js'

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

/**
 * Every subtype this module creates, and therefore the only ones it may
 * remove. Allow-list rather than deny-list on purpose: a service added by
 * another module survives by default, so Task 4's streaming and package-camera
 * services do not have to register anything here to avoid being torn down and
 * rebuilt — which would kill an active stream — on every discovery.
 */
const OWNED_SUBTYPES = new Set([...Object.keys(SUBTYPE_LABELS), 'led'])

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/**
 * Whether an absent detection type means "the user disabled it" or "this
 * payload could not be understood".
 *
 * `cameraSchema` makes `featureFlags` and `smartDetectSettings` required, but
 * `ProtectClient.validate` returns the **raw** payload when validation fails,
 * so one Ubiquiti field rename delivers a camera with neither. Read
 * optimistically that object yields `['motion']` — and removal would then strip
 * every smart-detect sensor, the Doorbell and the LED switch off all five
 * cameras, taking the user's automations with them.
 *
 * The same floor `platform.ts` applies to accessories, one layer down: act on
 * a payload you understood, never on one you did not. Removing nothing is
 * always recoverable; removing everything is not.
 *
 * Checks the FIELDS `desiredSubtypes` actually reads, not merely that their
 * containers are objects: a rename of `objectTypes` delivers
 * `{ smartDetectSettings: {}, featureFlags: {} }`, which passes a
 * container-only check while yielding `['motion']` — exactly the wipe this
 * guard exists to stop. Every one of these four is present on every camera
 * this hardware reports.
 */
export function isUnderstood(device: Record<string, unknown>): boolean {
  const settings = device.smartDetectSettings
  const flags = device.featureFlags
  return isRecord(settings) && isRecord(flags)
    && Array.isArray(settings.objectTypes) && Array.isArray(settings.audioTypes)
    && typeof flags.hasSpeaker === 'boolean' && typeof flags.hasLedStatus === 'boolean'
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
  const understood = isUnderstood(device)

  const info = accessory.getService(S.AccessoryInformation) ?? accessory.addService(S.AccessoryInformation)
  // Only from a payload we understood. A degraded one has no `mac`, so
  // SerialNumber would fall back to the device id — and a changed serial can
  // make HomeKit treat this as a different accessory entirely.
  if (understood) {
    info.setCharacteristic(C.Manufacturer, 'Ubiquiti')
      .setCharacteristic(C.Model, typeof device.modelKey === 'string' ? device.modelKey : 'camera')
      .setCharacteristic(C.SerialNumber, typeof device.mac === 'string' ? device.mac : String(device.id ?? 'unknown'))
  }

  const desired = desiredSubtypes(device)

  for (const subtype of desired) {
    const type = serviceTypeFor(api, subtype)
    const name = subtype === 'led' ? `${label} Status LED` : `${label} ${SUBTYPE_LABELS[subtype]}`
    let service = accessory.getServiceById(type, subtype)
    if (!service) {
      // The name is written once, here, and never again — writing it on every
      // discovery would overwrite whatever the user renamed the service to in
      // Home.app. Deliberately NOT also setting `ConfiguredName`:
      // hap-nodejs 2.1.9 declares it on neither MotionSensor, SmokeSensor,
      // CarbonMonoxideSensor, Doorbell nor Switch, so every write logged a
      // "[HAP] ... Adding anyway." warning — roughly 23 of them on this
      // console's first boot, which reads as a broken plugin.
      service = accessory.addService(type, name, subtype)
      log.debug(`Added ${subtype} service to "${label}".`)
    }

    if (subtype === 'led')
      wireLed(api, log, service, device, label, callbacks)
  }

  if (!understood) {
    log.warn(`Could not read the detection settings for "${label}" — keeping its existing sensors. Update the plugin if this persists.`)
    return
  }

  // Removal is destructive, so it runs only from a confirmed successful
  // discovery — the caller in platform.ts guarantees that — and only over
  // subtypes this module owns. Anything else on the accessory (Task 4's
  // CameraController streaming services, a package camera) is left alone
  // without having to register itself here.
  for (const service of [...accessory.services]) {
    const subtype = service.subtype
    if (!subtype || !OWNED_SUBTYPES.has(subtype) || desired.includes(subtype))
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
  // `removeOnSet`, not `removeAllListeners('set')`: hap-nodejs stores a single
  // `setHandler` that `onSet` overwrites, so the emitter call was inert against
  // the real library. Explicit clear, because "onSet happens to overwrite" is
  // not a contract worth relying on across a rebuild.
  characteristic.removeOnSet()
  characteristic.onSet(async (value) => {
    try {
      await callbacks.setLed(String(device.id), Boolean(value))
    }
    catch (error) {
      // errorMessage, never the error object: it carries request context and
      // util.inspect on it — which is what log.error(err) uses — has printed
      // the API key before. It also survives a reject(null).
      log.warn(`Could not change the status LED on "${label}": ${errorMessage(error)}`)
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
  // Only sensors fall through to MotionDetected. Without this the `led`
  // subtype would write MotionDetected onto a Switch — unreachable from the
  // router today, and a landmine for Task 5, which owns the LED.
  if (type === api.hap.Service.MotionSensor)
    service.updateCharacteristic(C.MotionDetected, change.active)
}
