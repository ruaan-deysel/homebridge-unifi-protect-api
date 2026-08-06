import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildLightServices,
  isUnderstoodLight,
  LED_LEVEL_MAX,
  ledLevelToPercent,
  percentToLedLevel,
} from '../src/accessories/light.js'
import { C, FakeAccessory, FakeHapStatusError, hap, S } from './fake-hap.js'

const lights = JSON.parse(readFileSync('test/fixtures/lights.json', 'utf8'))
const byName = (n: string) => lights.find((l: { name: string }) => l.name === n)

const api = { hap } as never
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() }

function setup(
  device: Record<string, unknown>,
  overrides: { setOn?: (id: string, on: boolean) => Promise<void>, setBrightness?: (id: string, level: number) => Promise<void> } = {},
) {
  const setOn = vi.fn(overrides.setOn ?? (async () => {}))
  const setBrightness = vi.fn(overrides.setBrightness ?? (async () => {}))
  const accessory = new FakeAccessory()
  const build = (next: Record<string, unknown> = device) =>
    buildLightServices(api, log as never, accessory as never, next, { setOn, setBrightness })
  build()
  return { accessory, build, setOn, setBrightness }
}

describe('brightness mapping', () => {
  it('maps ledLevel (1-6) to a HomeKit percentage', () => {
    expect(ledLevelToPercent(1)).toBe(17)
    expect(ledLevelToPercent(3)).toBe(50)
    expect(ledLevelToPercent(LED_LEVEL_MAX)).toBe(100)
  })

  it('maps a HomeKit percentage back to a clamped ledLevel', () => {
    expect(percentToLedLevel(100)).toBe(6)
    expect(percentToLedLevel(50)).toBe(3)
    expect(percentToLedLevel(1)).toBe(1)
    // Never below 1 or above 6, whatever HomeKit sends.
    expect(percentToLedLevel(0)).toBe(1)
    expect(percentToLedLevel(200)).toBe(6)
  })
})

describe('isUnderstoodLight', () => {
  it('is true for a real light payload', () => {
    expect(isUnderstoodLight(byName('Driveway Light'))).toBe(true)
  })

  it('is false for a degraded payload', () => {
    expect(isUnderstoodLight({ id: 'x' })).toBe(false)
    expect(isUnderstoodLight({ isLightOn: true, lightDeviceSettings: 'nope' })).toBe(false)
  })
})

describe('buildLightServices', () => {
  beforeEach(() => vi.clearAllMocks())

  it('builds a Lightbulb, a motion sensor and accessory information', () => {
    const device = byName('Driveway Light')
    const { accessory } = setup(device)

    expect(accessory.getServiceById(S.Lightbulb, 'light')).toBeDefined()
    expect(accessory.getServiceById(S.MotionSensor, 'light-motion')).toBeDefined()
    expect(accessory.getService(S.AccessoryInformation)?.valueOf_(C.SerialNumber)).toBe(device.mac)
    expect(accessory.getService(S.AccessoryInformation)?.valueOf_(C.Model)).toBe('light')
  })

  it('reflects the current on, brightness and motion state', () => {
    const { accessory } = setup(byName('Backyard Light'))
    const bulb = accessory.getServiceById(S.Lightbulb, 'light')!
    const motion = accessory.getServiceById(S.MotionSensor, 'light-motion')!

    expect(bulb.valueOf_(C.On)).toBe(true)
    expect(bulb.valueOf_(C.Brightness)).toBe(100)
    expect(motion.valueOf_(C.MotionDetected)).toBe(true)
  })

  it('reads On from isLightOn, not the force-enable flag', () => {
    // A light on via motion has isLightForceEnabled false but isLightOn true.
    const device = { ...byName('Driveway Light'), isLightOn: true, isLightForceEnabled: false }
    const { accessory } = setup(device)
    expect(accessory.getServiceById(S.Lightbulb, 'light')!.valueOf_(C.On)).toBe(true)
  })

  it('is idempotent — a second build adds nothing and leaves working handlers', async () => {
    const { accessory, build, setOn } = setup(byName('Driveway Light'))
    const before = accessory.services.length
    const bulb = accessory.getServiceById(S.Lightbulb, 'light')!

    build()
    build()

    expect(accessory.services.length).toBe(before)
    expect(accessory.getServiceById(S.Lightbulb, 'light')).toBe(bulb)
    await bulb.getCharacteristic(C.On).setHandler!(true)
    expect(setOn).toHaveBeenCalledTimes(1)
  })

  it('writes force-enable on an On change', async () => {
    const { accessory, setOn } = setup(byName('Driveway Light'))
    await accessory.getServiceById(S.Lightbulb, 'light')!.getCharacteristic(C.On).setHandler!(true)
    expect(setOn).toHaveBeenCalledWith('light000000000000000001', true)
  })

  it('writes a mapped ledLevel on a Brightness change', async () => {
    const { accessory, setBrightness } = setup(byName('Driveway Light'))
    await accessory.getServiceById(S.Lightbulb, 'light')!.getCharacteristic(C.Brightness).setHandler!(100)
    expect(setBrightness).toHaveBeenCalledWith('light000000000000000001', 6)
  })

  it('reverts the switch when a write fails', async () => {
    const setOn = vi.fn(async () => {
      throw new Error('console rejected it')
    })
    const { accessory } = setup(byName('Driveway Light'), { setOn })
    const handler = accessory.getServiceById(S.Lightbulb, 'light')!.getCharacteristic(C.On).setHandler!

    await expect(handler(true)).rejects.toBeInstanceOf(FakeHapStatusError)
    expect(log.warn).toHaveBeenCalled()
  })

  it('writes no SerialNumber from a degraded payload', () => {
    const { accessory } = setup({ id: 'light000000000000000001', name: 'Driveway Light' })
    // The Lightbulb and motion sensor are still built optimistically, but the
    // AccessoryInformation is left untouched so a changed serial cannot make
    // HomeKit treat this as a different accessory.
    expect(accessory.getServiceById(S.Lightbulb, 'light')).toBeDefined()
    expect(accessory.getService(S.AccessoryInformation)?.valueOf_(C.SerialNumber)).toBeUndefined()
  })

  it('tolerates a degraded payload without throwing', () => {
    expect(() => setup({ id: 'x', lightDeviceSettings: 'nope', isLightOn: 'yes' })).not.toThrow()
  })
})
