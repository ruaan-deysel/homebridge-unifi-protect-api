import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyChange, buildCameraServices, desiredSubtypes } from '../src/accessories/camera.js'
import { C, FakeAccessory, FakeHapStatusError, hap, S } from './fake-hap.js'

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

const api = { hap } as never
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() }

function setup(device: Record<string, unknown>, setLed = vi.fn(async () => {})) {
  const accessory = new FakeAccessory()
  const build = (next: Record<string, unknown> = device) =>
    buildCameraServices(api, log as never, accessory as never, next, { setLed })
  build()
  return { accessory, build, setLed }
}

const subtypesOf = (a: FakeAccessory) => a.services.map(s => s.subtype).filter(Boolean).sort()

describe('buildCameraServices', () => {
  beforeEach(() => vi.clearAllMocks())

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

  // The Critical. `ProtectClient.validate` returns the RAW payload when
  // cameraSchema fails, so one Ubiquiti field rename delivers a camera with no
  // smartDetectSettings and no featureFlags. Read optimistically that yields
  // ['motion'] — and an ungated removal loop then strips every smart-detect
  // sensor, the Doorbell and the LED switch off a fully-built accessory,
  // taking the user's automations with them. Third instance of this bug class
  // in this repo; the other two were also Critical.
  it('removes nothing when a degraded payload arrives for a populated accessory', () => {
    const { accessory, build } = setup(byName('Doorbell'))
    const before = [...accessory.services]
    expect(subtypesOf(accessory).length).toBe(7)

    // Every shape validation can fail into: absent, and present-but-wrong-type.
    for (const degraded of [
      { id: byName('Doorbell').id, name: 'Doorbell' },
      { ...byName('Doorbell'), smartDetectSettings: undefined },
      { ...byName('Doorbell'), featureFlags: 'renamed-by-firmware' },
      { ...byName('Doorbell'), smartDetectSettings: [], featureFlags: [] },
    ]) {
      build(degraded as Record<string, unknown>)
      expect(accessory.services, JSON.stringify(degraded).slice(0, 60)).toEqual(before)
    }

    expect(log.warn).toHaveBeenCalled()
    expect(JSON.stringify(log.warn.mock.calls)).toContain('keeping its existing sensors')
  })

  // A camera that genuinely has every type disabled must still be diffed —
  // otherwise the floor above would be indistinguishable from "never remove".
  it('still removes when the payload is understood and simply has nothing enabled', () => {
    const { accessory, build } = setup(byName('Doorbell'))

    build({ ...byName('Doorbell'), smartDetectSettings: { objectTypes: [], audioTypes: [] } })

    expect(subtypesOf(accessory)).toEqual(['led', 'motion', 'ring'])
  })

  // Task 4 adds CameraController streaming and a package-camera service. Those
  // must survive without registering anything here — tearing them down and
  // rebuilding them each discovery would kill an active stream.
  it('leaves services owned by other modules alone', () => {
    const { accessory, build } = setup(byName('Driveway'))
    const foreign = accessory.addService(S.Switch, 'Streaming', 'camera-stream')

    build()
    build({ ...byName('Driveway'), smartDetectSettings: { objectTypes: [], audioTypes: [] } })

    expect(accessory.getServiceById(S.Switch, 'camera-stream')).toBe(foreign)
  })

  it('never removes a subtype-less service such as accessory information', () => {
    const { accessory, build } = setup({ id: 'x' })
    build()
    expect(accessory.getService(S.AccessoryInformation)).toBeDefined()
    expect(subtypesOf(accessory)).toEqual(['motion'])
  })

  it('sets ConfiguredName once at creation and never overwrites a user rename', () => {
    const { accessory, build } = setup(byName('Garage'))
    const motion = accessory.getServiceById(S.MotionSensor, 'motion')!
    expect(motion.valueOf_(C.ConfiguredName)).toBe('Garage Motion')

    // What the user typed in Home.app.
    motion.setCharacteristic(C.ConfiguredName, 'Back Door Movement')
    build()

    expect(motion.valueOf_(C.ConfiguredName)).toBe('Back Door Movement')
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

    applyChange(api, accessory as never, { deviceId: device.id, subtype: 'motion', active: true })
    applyChange(api, accessory as never, { deviceId: device.id, subtype: 'detect-person', active: true })
    expect(accessory.getServiceById(S.MotionSensor, 'motion')?.valueOf_(C.MotionDetected)).toBe(true)
    expect(accessory.getServiceById(S.MotionSensor, 'detect-person')?.valueOf_(C.MotionDetected)).toBe(true)

    applyChange(api, accessory as never, { deviceId: device.id, subtype: 'motion', active: false })
    expect(accessory.getServiceById(S.MotionSensor, 'motion')?.valueOf_(C.MotionDetected)).toBe(false)
  })

  it('fires a doorbell press only on the active edge', () => {
    const { accessory } = setup(device)
    const ring = accessory.getServiceById(S.Doorbell, 'ring')!

    applyChange(api, accessory as never, { deviceId: device.id, subtype: 'ring', active: false })
    expect(ring.valueOf_(C.ProgrammableSwitchEvent)).toBeUndefined()

    applyChange(api, accessory as never, { deviceId: device.id, subtype: 'ring', active: true })
    expect(ring.valueOf_(C.ProgrammableSwitchEvent)).toBe(C.ProgrammableSwitchEvent.SINGLE_PRESS)
  })

  // SYNTHESIZED: no audio event exists in the fixtures — the shape is constructed.
  it('sets smoke and carbon monoxide both ways', () => {
    const audio = { ...device, smartDetectSettings: { objectTypes: [], audioTypes: ['alrmSmoke', 'alrmCmonx'] } }
    const { accessory } = setup(audio)
    const smoke = accessory.getServiceById(S.SmokeSensor, 'audio-alrmSmoke')!
    const co = accessory.getServiceById(S.CarbonMonoxideSensor, 'audio-alrmCmonx')!

    applyChange(api, accessory as never, { deviceId: device.id, subtype: 'audio-alrmSmoke', active: true })
    applyChange(api, accessory as never, { deviceId: device.id, subtype: 'audio-alrmCmonx', active: true })
    expect(smoke.valueOf_(C.SmokeDetected)).toBe(C.SmokeDetected.SMOKE_DETECTED)
    expect(co.valueOf_(C.CarbonMonoxideDetected)).toBe(C.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL)

    applyChange(api, accessory as never, { deviceId: device.id, subtype: 'audio-alrmSmoke', active: false })
    applyChange(api, accessory as never, { deviceId: device.id, subtype: 'audio-alrmCmonx', active: false })
    expect(smoke.valueOf_(C.SmokeDetected)).toBe(C.SmokeDetected.SMOKE_NOT_DETECTED)
    expect(co.valueOf_(C.CarbonMonoxideDetected)).toBe(C.CarbonMonoxideDetected.CO_LEVELS_NORMAL)
  })

  // Unreachable from the router today, but Task 5 owns the LED and this is
  // where a stray `led` change would silently write MotionDetected on a Switch.
  it('never writes a sensor characteristic onto the LED switch', () => {
    const { accessory } = setup(byName('Garage'))
    const led = accessory.getServiceById(S.Switch, 'led')!
    const on = led.valueOf_(C.On)

    applyChange(api, accessory as never, { deviceId: device.id, subtype: 'led', active: true })

    expect(led.valueOf_(C.MotionDetected)).toBeUndefined()
    expect(led.valueOf_(C.On)).toBe(on)
  })

  it('ignores a subtype with no service without throwing', () => {
    const { accessory } = setup(byName('Sidegate'))

    // Unknown to the builder entirely, and known-but-not-built on this camera.
    for (const subtype of ['nonsense', 'detect-vehicle', 'ring', 'led', 'audio-alrmSmoke'])
      expect(() => applyChange(api, accessory as never, { deviceId: 'x', subtype, active: true }), subtype).not.toThrow()

    expect(subtypesOf(accessory)).toEqual(['detect-animal', 'detect-person', 'motion'])
  })
})
