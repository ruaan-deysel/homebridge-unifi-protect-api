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
  Microphone: { name: 'Microphone' },
  CameraRTPStreamManagement: { name: 'CameraRTPStreamManagement' },
  CameraRecordingManagement: { name: 'CameraRecordingManagement' },
  CameraOperatingMode: { name: 'CameraOperatingMode' },
  DataStreamTransportManagement: { name: 'DataStreamTransportManagement' },
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

/**
 * Stands in for `hap.CameraController`. Real HAP's `configureController` calls
 * `constructServices()` and adds everything it returns to the accessory, so the
 * services a controller brings with it are modelled here rather than assumed
 * away: the RTP stream managements carry a numeric subtype (`"0"`, `"1"`, ...),
 * which is what `camera.ts`'s removal loop has to leave alone.
 */
export class FakeCameraController {
  constructor(public readonly options: Record<string, unknown>) {}

  constructServices(): FakeService[] {
    const count = (this.options.cameraStreamCount as number | undefined) ?? 1
    const services = Array.from({ length: count }, (_, i) => new FakeService(S.CameraRTPStreamManagement, undefined, String(i)))
    // HAP adds a Microphone service only when audio is actually advertised.
    if ((this.options.streamingOptions as { audio?: unknown } | undefined)?.audio)
      services.push(new FakeService(S.Microphone, 'Microphone'))
    // HAP builds the whole RecordingManagement — CameraOperatingMode included —
    // from the `recording` option alone. Modelled so a test can catch anyone
    // adding CameraOperatingMode by hand beside it.
    if (this.options.recording) {
      services.push(
        new FakeService(S.CameraRecordingManagement, 'Recording Management'),
        new FakeService(S.CameraOperatingMode, 'Operating Mode'),
        new FakeService(S.DataStreamTransportManagement, 'Data Stream Transport Management'),
      )
    }
    return services
  }
}

/**
 * The mistake this fake exists to catch: a `DoorbellController` brings its OWN
 * Doorbell service, which lands beside the subtyped `ring` one the event
 * pipeline already drives and makes the doorbell appear twice in Home.app.
 */
export class FakeDoorbellController extends FakeCameraController {
  constructServices(): FakeService[] {
    return [...super.constructServices(), new FakeService(S.Doorbell, 'Doorbell')]
  }
}

export class FakeAccessory {
  services: FakeService[] = []
  controllers: FakeCameraController[] = []

  configureController(controller: FakeCameraController) {
    this.controllers.push(controller)
    this.services.push(...controller.constructServices())
  }

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

/** The `api.hap` shape `camera.ts` and `platform.ts` read. */
export const hap = {
  Service: S,
  Characteristic: C,
  HapStatusError: FakeHapStatusError,
  HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
  CameraController: FakeCameraController,
  DoorbellController: FakeDoorbellController,
  SRTPCryptoSuites: { AES_CM_128_HMAC_SHA1_80: 0, AES_CM_256_HMAC_SHA1_80: 1, NONE: 2 },
  H264Profile: { BASELINE: 0, MAIN: 1, HIGH: 2 },
  H264Level: { LEVEL3_1: 0, LEVEL3_2: 1, LEVEL4_0: 2 },
  // HKSV. Every value is the real hap-nodejs one — these go on the wire, so a
  // made-up number would let a test agree with a wrong advertisement.
  VideoCodecType: { H264: 0 },
  MediaContainerType: { FRAGMENTED_MP4: 0 },
  EventTriggerOption: { MOTION: 1, DOORBELL: 2 },
  AudioRecordingCodecType: { AAC_LC: 0, AAC_ELD: 1 },
  AudioRecordingSamplerate: { KHZ_8: 0, KHZ_16: 1, KHZ_24: 2, KHZ_32: 3, KHZ_44_1: 4, KHZ_48: 5 },
  AudioBitrate: { VARIABLE: 0, CONSTANT: 1 },
}
