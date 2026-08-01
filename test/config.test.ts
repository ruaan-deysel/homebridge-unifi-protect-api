import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseConfig, settingsFor, storeConsoleCert } from '../src/config.js'

const minimal = { platform: 'UniFiProtect', name: 'UniFi Protect', host: '10.0.0.1', apiKey: 'k' }

describe('parseConfig', () => {
  it('rejects a config with no host', () => {
    const result = parseConfig({ platform: 'UniFiProtect', apiKey: 'k' })
    expect(result.success).toBe(false)
    expect(!result.success && result.error.issues.map(issue => issue.message)).toContain(
      'host is required — the IP or hostname of your UniFi console',
    )
  })

  it('rejects a config with no api key', () => {
    const result = parseConfig({ platform: 'UniFiProtect', host: '10.0.0.1' })
    expect(result.success).toBe(false)
    expect(!result.success && result.error.issues.map(issue => issue.message)).toContain(
      'apiKey is required — create one in UniFi Site Manager → Integrations',
    )
  })

  // An empty string, not a missing key, is what a user who saves the settings
  // form blank actually produces.
  it('rejects an empty host or api key', () => {
    expect(parseConfig({ ...minimal, host: '' }).success).toBe(false)
    expect(parseConfig({ ...minimal, apiKey: '' }).success).toBe(false)
  })

  // Trust-on-first-use has nothing to store on a fresh install, and a config
  // that demanded a certificate could never be created in the first place.
  it('accepts a config with no trusted certificate, and keeps one that has it', () => {
    expect(parseConfig(minimal).success).toBe(true)
    const result = parseConfig({ ...minimal, consoleCert: 'PEM' })
    expect(result.success && result.data.consoleCert).toBe('PEM')
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
    expect(strict.success && settingsFor(strict.data, 'unseen')).toMatchObject({
      expose: false,
      quality: 'high',
      hksv: false,
    })
  })

  it('leaves hksv off by default — the 200GB iCloud plan supports only one camera', () => {
    expect(settingsFor(data, 'unseen').hksv).toBe(false)
  })
})

describe('storeConsoleCert', () => {
  const write = (contents: unknown) => {
    const path = join(mkdtempSync(join(tmpdir(), 'protect-config-test-')), 'config.json')
    writeFileSync(path, JSON.stringify(contents, null, 4))
    return path
  }
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

  it('writes the certificate into our block and leaves everything else alone', () => {
    const path = write({
      bridge: { name: 'Homebridge', pin: '031-45-154' },
      platforms: [
        { platform: 'SomeoneElse', host: '10.0.0.1' },
        { ...minimal, _bridge: { username: 'AA:BB', port: 1234 }, devices: { cam1: { expose: false } } },
      ],
    })

    storeConsoleCert(path, '10.0.0.1', 'PEM')

    const saved = read(path)
    expect(saved.platforms[1].consoleCert).toBe('PEM')
    // The child bridge's credentials survive — losing them re-pairs every
    // accessory and takes the user's rooms, scenes and automations with it.
    expect(saved.platforms[1]._bridge).toEqual({ username: 'AA:BB', port: 1234 })
    expect(saved.platforms[1].devices).toEqual({ cam1: { expose: false } })
    expect(saved.platforms[0]).toEqual({ platform: 'SomeoneElse', host: '10.0.0.1' })
    expect(saved.bridge).toEqual({ name: 'Homebridge', pin: '031-45-154' })
  })

  it('writes to the block for the matching host when there is more than one', () => {
    const path = write({ platforms: [{ ...minimal, host: '10.0.0.2' }, { ...minimal, host: '10.0.0.1' }] })

    storeConsoleCert(path, '10.0.0.1', 'PEM')

    const saved = read(path)
    expect(saved.platforms[0].consoleCert).toBeUndefined()
    expect(saved.platforms[1].consoleCert).toBe('PEM')
  })

  // Better to re-learn the certificate on the next start than to write this
  // console's identity into some other console's block.
  it('refuses rather than guessing when no block matches', () => {
    const path = write({ platforms: [{ ...minimal, host: '10.0.0.2' }, { ...minimal, host: '10.0.0.3' }] })

    expect(() => storeConsoleCert(path, '10.0.0.1', 'PEM')).toThrow(/10\.0\.0\.1/)
    expect(read(path).platforms.some((block: { consoleCert?: string }) => block.consoleCert)).toBe(false)
  })
})
