import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { applyChange, buildCameraServices, desiredSubtypes } from '../src/accessories/camera.js'

const cameras = JSON.parse(readFileSync('test/fixtures/cameras.json', 'utf8'))
const byName = (n: string) => cameras.find((c: { name: string }) => c.name === n)

describe('desiredSubtypes', () => {
  it('exposes only the detection types enabled on each real camera', () => {
    expect(desiredSubtypes(byName('Doorbell')).sort()).toEqual(
      ['detect-animal', 'detect-package', 'detect-person', 'detect-vehicle', 'led', 'motion', 'ring'].sort(),
    )
    // Backyard supports vehicle but has it disabled in Protect, so no Vehicle sensor.
    expect(desiredSubtypes(byName('Backyard'))).not.toContain('detect-vehicle')
    expect(desiredSubtypes(byName('Backyard'))).toContain('detect-person')
  })

  it('omits the LED switch on a camera without a status LED', () => {
    expect(desiredSubtypes(byName('Sidegate'))).not.toContain('led')
    expect(desiredSubtypes(byName('Garage'))).toContain('led')
  })

  it('only the doorbell gets a ring service', () => {
    expect(desiredSubtypes(byName('Doorbell'))).toContain('ring')
    for (const n of ['Backyard', 'Driveway', 'Sidegate', 'Garage'])
      expect(desiredSubtypes(byName(n)), n).not.toContain('ring')
  })

  // SYNTHESIZED: audio detection is disabled on every camera on this hardware and
  // Task 0 captured no audio event, so the enabled state is constructed here.
  it('audio sensors appear only once enabled in Protect', () => {
    const camera = { ...byName('Garage'), smartDetectSettings: { objectTypes: ['person'], audioTypes: ['alrmSmoke', 'alrmBark'] } }
    const subtypes = desiredSubtypes(camera)
    expect(subtypes).toContain('audio-alrmSmoke')
    // Bark has no native HomeKit service and must not be exposed.
    expect(subtypes).not.toContain('audio-alrmBark')
  })

  it('ignores an unknown detection type from a firmware update', () => {
    const camera = { smartDetectSettings: { objectTypes: ['person', 'unicorn'] } }
    expect(desiredSubtypes(camera)).toEqual(['motion', 'detect-person'])
  })

  it('tolerates a degraded payload with fields missing', () => {
    expect(() => desiredSubtypes({ id: 'x' })).not.toThrow()
    expect(desiredSubtypes({ id: 'x' })).toEqual(['motion'])
    // A degraded payload can carry the wrong *type*, not just a missing field.
    expect(() => desiredSubtypes({ smartDetectSettings: 'nope', featureFlags: [] })).not.toThrow()
    expect(desiredSubtypes({ smartDetectSettings: { objectTypes: [1, null, 'person'] } })).toEqual(['motion', 'detect-person'])
  })
})

// ---------------------------------------------------------------------------
// A HAP stand-in. Service and characteristic "types" are plain objects used as
// identity tokens, which is all the builder ever does with them.
// ---------------------------------------------------------------------------

const S = {
  AccessoryInformation: { name: 'AccessoryInformation' },
  MotionSensor: { name: 'MotionSensor' },
  SmokeSensor: { name: 'SmokeSensor' },
  CarbonMonoxideSensor: { name: 'CarbonMonoxideSensor' },
  Doorbell: { name: 'Doorbell' },
  Switch: { name: 'Switch' },
}

const C = {
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

class FakeCharacteristic extends EventEmitter {
  value: unknown = null
  onSet(handler: (value: unknown) => unknown) {
    this.on('set', handler)
    return this
  }
}

class FakeService {
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

class FakeAccessory {
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

class FakeHapStatusError extends Error {
  constructor(public hapStatus: number) {
    super(`hap status ${hapStatus}`)
  }
}

const api = {
  hap: { Service: S, Characteristic: C, HapStatusError: FakeHapStatusError, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } },
} as never
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() }

function setup(device: Record<string, unknown>, setLed = vi.fn(async () => {})) {
  const accessory = new FakeAccessory()
  const build = () => buildCameraServices(api, log as never, accessory as never, device, { setLed })
  build()
  return { accessory, build, setLed }
}

const subtypesOf = (a: FakeAccessory) => a.services.map(s => s.subtype).filter(Boolean).sort()

describe('buildCameraServices', () => {
  it('builds exactly the desired set plus accessory information', () => {
    const device = byName('Doorbell')
    const { accessory } = setup(device)

    expect(subtypesOf(accessory)).toEqual(desiredSubtypes(device).sort())
    expect(accessory.getService(S.AccessoryInformation)).toBeDefined()
    expect(accessory.getService(S.AccessoryInformation)?.valueOf_(C.SerialNumber)).toBe(device.mac)
    expect(accessory.getServiceById(S.Doorbell, 'ring')).toBeDefined()
    expect(accessory.getServiceById(S.Switch, 'led')).toBeDefined()
    expect(accessory.getServiceById(S.MotionSensor, 'detect-person')).toBeDefined()
  })

  it('is idempotent — a second build adds nothing and stacks no handlers', () => {
    const { accessory, build } = setup(byName('Doorbell'))
    const before = accessory.services.length
    const led = accessory.getServiceById(S.Switch, 'led')!

    build()
    build()

    expect(accessory.services.length).toBe(before)
    expect(accessory.getServiceById(S.Switch, 'led')).toBe(led)
    // Re-registering onSet on every discovery would fire the write N times.
    expect(led.getCharacteristic(C.On).listenerCount('set')).toBe(1)
  })

  it('removes exactly the disabled type and leaves every other service intact', () => {
    const device = { ...byName('Driveway') } as Record<string, unknown>
    const { accessory, build } = setup(device)
    expect(subtypesOf(accessory)).toContain('detect-vehicle')
    const motion = accessory.getServiceById(S.MotionSensor, 'motion')!

    device.smartDetectSettings = { objectTypes: ['person', 'animal'], audioTypes: [] }
    build()

    expect(subtypesOf(accessory)).toEqual(['detect-animal', 'detect-person', 'led', 'motion'])
    // Not merely absent from the list — the surviving objects are the originals.
    expect(accessory.getServiceById(S.MotionSensor, 'motion')).toBe(motion)
    expect(accessory.getService(S.AccessoryInformation)).toBeDefined()
  })

  it('never removes a subtype-less service such as accessory information', () => {
    const { accessory, build } = setup({ id: 'x' })
    build()
    expect(accessory.getService(S.AccessoryInformation)).toBeDefined()
    expect(subtypesOf(accessory)).toEqual(['motion'])
  })

  it('names services from the device but falls back when the name is unusable', () => {
    const { accessory } = setup({ id: 'x', name: '   ' })
    expect(accessory.getServiceById(S.MotionSensor, 'motion')?.displayName).toBe('Camera Motion')
  })

  it('writes the LED through to Protect and rejects the write when Protect refuses', async () => {
    const setLed = vi.fn(async () => {})
    const { accessory } = setup({ ...byName('Backyard') }, setLed)
    const on = accessory.getServiceById(S.Switch, 'led')!.getCharacteristic(C.On)
    // ledSettings.isEnabled is true on Backyard, so HomeKit starts on.
    expect(on.value).toBe(true)

    const fire = (value: unknown) => Promise.all(on.listeners('set').map(h => h(value)))
    await fire(false)
    expect(setLed).toHaveBeenCalledWith(byName('Backyard').id, false)

    // A handler that resolves tells HAP the write succeeded and HAP commits the
    // new value — so a failed write MUST reject, or the switch sticks on a
    // state Protect never accepted.
    setLed.mockRejectedValueOnce(new Error('403 from Protect'))
    await expect(fire(true)).rejects.toBeInstanceOf(FakeHapStatusError)
    expect(log.warn).toHaveBeenCalled()
    // The API key travels on the client, not the message: nothing but the
    // error's own message may reach the log.
    expect(JSON.stringify(log.warn.mock.calls)).toContain('403 from Protect')
  })
})

describe('applyChange', () => {
  const device = byName('Doorbell')

  it('sets motion on the plain and per-type motion sensors', () => {
    const { accessory } = setup(device)

    applyChange(api, accessory as never, { subtype: 'motion', active: true })
    applyChange(api, accessory as never, { subtype: 'detect-person', active: true })
    expect(accessory.getServiceById(S.MotionSensor, 'motion')?.valueOf_(C.MotionDetected)).toBe(true)
    expect(accessory.getServiceById(S.MotionSensor, 'detect-person')?.valueOf_(C.MotionDetected)).toBe(true)

    applyChange(api, accessory as never, { subtype: 'motion', active: false })
    expect(accessory.getServiceById(S.MotionSensor, 'motion')?.valueOf_(C.MotionDetected)).toBe(false)
  })

  it('fires a doorbell press only on the active edge', () => {
    const { accessory } = setup(device)
    const ring = accessory.getServiceById(S.Doorbell, 'ring')!

    applyChange(api, accessory as never, { subtype: 'ring', active: false })
    expect(ring.valueOf_(C.ProgrammableSwitchEvent)).toBeUndefined()

    applyChange(api, accessory as never, { subtype: 'ring', active: true })
    expect(ring.valueOf_(C.ProgrammableSwitchEvent)).toBe(C.ProgrammableSwitchEvent.SINGLE_PRESS)
  })

  // SYNTHESIZED: no audio event exists in the fixtures — the shape is constructed.
  it('sets smoke and carbon monoxide both ways', () => {
    const audio = { ...device, smartDetectSettings: { objectTypes: [], audioTypes: ['alrmSmoke', 'alrmCmonx'] } }
    const { accessory } = setup(audio)
    const smoke = accessory.getServiceById(S.SmokeSensor, 'audio-alrmSmoke')!
    const co = accessory.getServiceById(S.CarbonMonoxideSensor, 'audio-alrmCmonx')!

    applyChange(api, accessory as never, { subtype: 'audio-alrmSmoke', active: true })
    applyChange(api, accessory as never, { subtype: 'audio-alrmCmonx', active: true })
    expect(smoke.valueOf_(C.SmokeDetected)).toBe(C.SmokeDetected.SMOKE_DETECTED)
    expect(co.valueOf_(C.CarbonMonoxideDetected)).toBe(C.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL)

    applyChange(api, accessory as never, { subtype: 'audio-alrmSmoke', active: false })
    applyChange(api, accessory as never, { subtype: 'audio-alrmCmonx', active: false })
    expect(smoke.valueOf_(C.SmokeDetected)).toBe(C.SmokeDetected.SMOKE_NOT_DETECTED)
    expect(co.valueOf_(C.CarbonMonoxideDetected)).toBe(C.CarbonMonoxideDetected.CO_LEVELS_NORMAL)
  })

  it('ignores a subtype with no service without throwing', () => {
    const { accessory } = setup(byName('Sidegate'))

    // Unknown to the builder entirely, and known-but-not-built on this camera.
    for (const subtype of ['nonsense', 'detect-vehicle', 'ring', 'led', 'audio-alrmSmoke'])
      expect(() => applyChange(api, accessory as never, { subtype, active: true }), subtype).not.toThrow()

    expect(subtypesOf(accessory)).toEqual(['detect-animal', 'detect-person', 'motion'])
  })
})
