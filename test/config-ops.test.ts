import { describe, expect, it } from 'vitest'
import { DEFAULTS, ensureConfig, setDeviceSetting } from '../homebridge-ui/public/config-ops.js'

describe('ensureConfig', () => {
  it('fills in the shape the UI expects', () => {
    expect(ensureConfig({})).toEqual({
      platform: 'UniFiProtect',
      name: 'UniFi Protect',
      host: '',
      apiKey: '',
      defaults: DEFAULTS,
      devices: {},
    })
  })
})

describe('setDeviceSetting', () => {
  it('stores a value that differs from the default', () => {
    const config = setDeviceSetting(ensureConfig({}), 'cam1', 'hksv', true)
    expect(config.devices.cam1).toEqual({ hksv: true })
  })

  it('removes an override that matches the default', () => {
    let config = setDeviceSetting(ensureConfig({}), 'cam1', 'hksv', true)
    config = setDeviceSetting(config, 'cam1', 'hksv', false)
    expect(config.devices.cam1).toBeUndefined()
  })

  it('keys by device id so a rename cannot lose settings', () => {
    const config = setDeviceSetting(ensureConfig({}), '665e623c01493103e401c8bf', 'quality', 'low')
    expect(Object.keys(config.devices)).toEqual(['665e623c01493103e401c8bf'])
  })

  it('does not mutate the input config', () => {
    const original = ensureConfig({})
    setDeviceSetting(original, 'cam1', 'hksv', true)
    expect(original.devices).toEqual({})
  })
})
