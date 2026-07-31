import { describe, expect, it } from 'vitest'
import { parseConfig, settingsFor } from '../src/config.js'

const minimal = { platform: 'UniFiProtect', name: 'UniFi Protect', host: '10.0.0.1', apiKey: 'k' }

describe('parseConfig', () => {
  it('rejects a config with no host', () => {
    const result = parseConfig({ platform: 'UniFiProtect', apiKey: 'k' })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).toContain('host')
  })

  it('rejects a config with no api key', () => {
    const result = parseConfig({ platform: 'UniFiProtect', host: '10.0.0.1' })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result)).toContain('apiKey')
  })

  it('applies defaults when none are supplied', () => {
    const result = parseConfig(minimal)
    expect(result.success).toBe(true)
    expect(result.success && result.data.defaults).toEqual({
      exposeNewDevices: true,
      quality: 'high',
      hksv: false,
    })
  })
})

describe('settingsFor', () => {
  const config = parseConfig({
    ...minimal,
    defaults: { exposeNewDevices: true, quality: 'low', hksv: false },
    devices: { cam1: { hksv: true, smartDetect: ['person'] } },
  })
  const data = config.success
    ? config.data
    : (() => {
        throw new Error('config should parse')
      })()

  it('merges device overrides over defaults', () => {
    expect(settingsFor(data, 'cam1')).toMatchObject({ quality: 'low', hksv: true, smartDetect: ['person'], expose: true })
  })

  it('falls back to exposeNewDevices for an unknown device', () => {
    expect(settingsFor(data, 'unseen')).toMatchObject({ expose: true, quality: 'low', hksv: false })
  })

  it('hides new devices when exposeNewDevices is false', () => {
    const strict = parseConfig({ ...minimal, defaults: { exposeNewDevices: false } })
    expect(strict.success && settingsFor(strict.data, 'unseen').expose).toBe(false)
  })

  it('leaves hksv off by default — the 200GB iCloud plan supports only one camera', () => {
    expect(settingsFor(data, 'unseen').hksv).toBe(false)
  })
})
