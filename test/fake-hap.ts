/**
 * A HAP stand-in. Service and characteristic "types" are plain objects used as
 * identity tokens, which is all `camera.ts` ever does with them.
 *
 * Shared by `camera.test.ts` (which exercises the builder directly) and
 * `platform.test.ts` (which drives it through discovery), so both agree on
 * exactly what HomeKit is assumed to do.
 */

export const S = {
  AccessoryInformation: { name: 'AccessoryInformation' },
  MotionSensor: { name: 'MotionSensor' },
  SmokeSensor: { name: 'SmokeSensor' },
  CarbonMonoxideSensor: { name: 'CarbonMonoxideSensor' },
  Doorbell: { name: 'Doorbell' },
  Switch: { name: 'Switch' },
}

export const C = {
  Manufacturer: { name: 'Manufacturer' },
  Model: { name: 'Model' },
  SerialNumber: { name: 'SerialNumber' },
  ConfiguredName: { name: 'ConfiguredName' },
  Name: { name: 'Name' },
  On: { name: 'On' },
  MotionDetected: { name: 'MotionDetected' },
  SmokeDetected: { name: 'SmokeDetected', SMOKE_DETECTED: 1, SMOKE_NOT_DETECTED: 0 },
  CarbonMonoxideDetected: { name: 'CarbonMonoxideDetected', CO_LEVELS_ABNORMAL: 1, CO_LEVELS_NORMAL: 0 },
  ProgrammableSwitchEvent: { name: 'ProgrammableSwitchEvent', SINGLE_PRESS: 0 },
}

/**
 * hap-nodejs keeps exactly ONE `set` handler: `onSet` overwrites whatever was
 * there and the removal API is `removeOnSet()`. Modelled as a single slot and
 * NOT as an EventEmitter — an emitter fake lets a test drive a handler array
 * that does not exist in production, which is the code-and-tests-share-a-false-
 * premise failure that has already produced a real bug on this branch.
 */
export class FakeCharacteristic {
  value: unknown = null
  setHandler?: (value: unknown) => unknown

  onSet(handler: (value: unknown) => unknown) {
    this.setHandler = handler
    return this
  }

  removeOnSet() {
    this.setHandler = undefined
    return this
  }
}

export class FakeService {
  readonly characteristics = new Map<object, FakeCharacteristic>()
  constructor(public type: object, public displayName?: string, public subtype?: string) {}

  getCharacteristic(type: object): FakeCharacteristic {
    let c = this.characteristics.get(type)
    if (!c)
      this.characteristics.set(type, c = new FakeCharacteristic())
    return c
  }

  setCharacteristic(type: object, value: unknown) {
    this.getCharacteristic(type).value = value
    return this
  }

  updateCharacteristic(type: object, value: unknown) {
    this.getCharacteristic(type).value = value
    return this
  }

  valueOf_(type: object) {
    return this.characteristics.get(type)?.value
  }
}

export class FakeAccessory {
  services: FakeService[] = []
  getService(type: object) {
    return this.services.find(s => s.type === type && !s.subtype)
  }

  getServiceById(type: object, subtype: string) {
    return this.services.find(s => s.type === type && s.subtype === subtype)
  }

  addService(type: object, displayName?: string, subtype?: string) {
    const service = new FakeService(type, displayName, subtype)
    this.services.push(service)
    return service
  }

  removeService(service: FakeService) {
    this.services = this.services.filter(s => s !== service)
  }
}

export class FakeHapStatusError extends Error {
  constructor(public hapStatus: number) {
    super(`hap status ${hapStatus}`)
  }
}

/** The `api.hap` shape `camera.ts` reads. */
export const hap = {
  Service: S,
  Characteristic: C,
  HapStatusError: FakeHapStatusError,
  HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
}
