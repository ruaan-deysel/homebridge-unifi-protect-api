import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildChimeServices, chimeVolume, isUnderstoodChime } from '../src/accessories/chime.js'
import { C, FakeAccessory, FakeHapStatusError, hap, S } from './fake-hap.js'

const chimes = JSON.parse(readFileSync('test/fixtures/chimes.json', 'utf8'))
const dingDong = chimes[0]

const api = { hap } as never
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() }

function setup(device: Record<string, unknown>, overrides: { setVolume?: (id: string, v: number) => Promise<void> } = {}) {
  const setVolume = vi.fn(overrides.setVolume ?? (async () => {}))
  const accessory = new FakeAccessory()
  const build = (next: Record<string, unknown> = device) =>
    buildChimeServices(api, log as never, accessory as never, next, { setVolume })
  build()
  return { accessory, build, setVolume }
}

describe('chimeVolume', () => {
  it('reads the loudest paired ring', () => {
    expect(chimeVolume(dingDong)).toBe(80)
    expect(chimeVolume({ ringSettings: [{ volume: 20 }, { volume: 65 }] })).toBe(65)
  })

  it('is silent when there are no ring settings or they are malformed', () => {
    expect(chimeVolume({})).toBe(0)
    expect(chimeVolume({ ringSettings: 'nope' })).toBe(0)
    expect(chimeVolume({ ringSettings: [{}, 7] })).toBe(0)
  })
})

describe('isUnderstoodChime', () => {
  it('is true only when ring settings are present', () => {
    expect(isUnderstoodChime(dingDong)).toBe(true)
    expect(isUnderstoodChime({ id: 'x' })).toBe(false)
  })
})

describe('buildChimeServices', () => {
  beforeEach(() => vi.clearAllMocks())

  it('builds a volume Lightbulb and accessory information', () => {
    const { accessory } = setup(dingDong)
    const bulb = accessory.getServiceById(S.Lightbulb, 'chime-volume')!

    expect(bulb).toBeDefined()
    expect(bulb.valueOf_(C.On)).toBe(true)
    expect(bulb.valueOf_(C.Brightness)).toBe(80)
    expect(accessory.getService(S.AccessoryInformation)?.valueOf_(C.SerialNumber)).toBe(dingDong.mac)
    expect(accessory.getService(S.AccessoryInformation)?.valueOf_(C.Model)).toBe('chime')
  })

  it('reads off when every ring is silent', () => {
    const { accessory } = setup({ ...dingDong, ringSettings: [{ cameraId: 'c', volume: 0, repeatTimes: 1 }] })
    expect(accessory.getServiceById(S.Lightbulb, 'chime-volume')!.valueOf_(C.On)).toBe(false)
  })

  it('is idempotent — a second build adds nothing and leaves working handlers', async () => {
    const { accessory, build, setVolume } = setup(dingDong)
    const before = accessory.services.length
    const bulb = accessory.getServiceById(S.Lightbulb, 'chime-volume')!

    build()
    build()

    expect(accessory.services.length).toBe(before)
    expect(accessory.getServiceById(S.Lightbulb, 'chime-volume')).toBe(bulb)
    await bulb.getCharacteristic(C.Brightness).setHandler!(30)
    expect(setVolume).toHaveBeenCalledTimes(1)
  })

  it('writes the exact brightness as the new volume', async () => {
    const { accessory, setVolume } = setup(dingDong)
    await accessory.getServiceById(S.Lightbulb, 'chime-volume')!.getCharacteristic(C.Brightness).setHandler!(55)
    expect(setVolume).toHaveBeenCalledWith(dingDong.id, 55)
  })

  it('restores full volume when switched on from silent', async () => {
    const silent = { ...dingDong, ringSettings: [{ cameraId: 'c', volume: 0, repeatTimes: 1 }] }
    const { accessory, setVolume } = setup(silent)
    await accessory.getServiceById(S.Lightbulb, 'chime-volume')!.getCharacteristic(C.On).setHandler!(true)
    expect(setVolume).toHaveBeenCalledWith(dingDong.id, 100)
  })

  it('silences on a switch-off', async () => {
    const { accessory, setVolume } = setup(dingDong)
    await accessory.getServiceById(S.Lightbulb, 'chime-volume')!.getCharacteristic(C.On).setHandler!(false)
    expect(setVolume).toHaveBeenCalledWith(dingDong.id, 0)
  })

  it('restores the last set brightness across an off then on', async () => {
    const { accessory, setVolume } = setup(dingDong)
    const bulb = accessory.getServiceById(S.Lightbulb, 'chime-volume')!

    await bulb.getCharacteristic(C.Brightness).setHandler!(40)
    await bulb.getCharacteristic(C.On).setHandler!(false)
    await bulb.getCharacteristic(C.On).setHandler!(true)

    // Not full volume: on restores the 40 the user set, not the fixture's 80.
    expect(setVolume).toHaveBeenLastCalledWith(dingDong.id, 40)
  })

  it('reverts the tile when a write fails', async () => {
    const setVolume = vi.fn(async () => {
      throw new Error('console rejected it')
    })
    const { accessory } = setup(dingDong, { setVolume })
    const handler = accessory.getServiceById(S.Lightbulb, 'chime-volume')!.getCharacteristic(C.Brightness).setHandler!

    await expect(handler(30)).rejects.toBeInstanceOf(FakeHapStatusError)
    expect(log.warn).toHaveBeenCalled()
  })

  it('writes no SerialNumber from a degraded payload', () => {
    const { accessory } = setup({ id: dingDong.id, name: 'Ding Dong' })
    expect(accessory.getServiceById(S.Lightbulb, 'chime-volume')).toBeDefined()
    expect(accessory.getService(S.AccessoryInformation)?.valueOf_(C.SerialNumber)).toBeUndefined()
  })
})
