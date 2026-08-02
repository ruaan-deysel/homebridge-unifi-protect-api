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

  // Omitting `defaults` hits the OUTER `.default({...})` literal on the object,
  // which is a SEPARATE source of truth from the per-field `.default()`s. This
  // test therefore pins the literal, and the one below pins the fields — asserting
  // only this one is how three earlier defects here stayed green.
  it('applies the whole defaults block when it is absent', () => {
    const result = parseConfig(minimal)
    expect(result.success).toBe(true)
    expect(result.success && result.data.defaults).toEqual({
      exposeNewDevices: true,
      // 'auto', not a pinned substream: the right one depends on what HomeKit
      // asks for, and a 2688x1512 transcode for a phone thumbnail is 27x the CPU.
      quality: 'auto',
      hksv: false,
    })
  })

  // A PARTIAL defaults block — what anyone who has ever changed one setting has
  // — falls through to the per-field defaults instead. `exposeNewDevices:
  // z.boolean().default(false)` would hide every camera from HomeKit for those
  // users, and nothing above would have noticed.
  it('applies each field default individually inside a partial defaults block', () => {
    const byQuality = parseConfig({ ...minimal, defaults: { quality: 'low' } })
    expect(byQuality.success && byQuality.data.defaults).toEqual({
      exposeNewDevices: true,
      quality: 'low',
      hksv: false,
    })

    const byExpose = parseConfig({ ...minimal, defaults: { exposeNewDevices: false } })
    expect(byExpose.success && byExpose.data.defaults).toEqual({
      exposeNewDevices: false,
      quality: 'auto',
      hksv: false,
    })

    const byHksv = parseConfig({ ...minimal, defaults: { hksv: true } })
    expect(byHksv.success && byHksv.data.defaults).toEqual({
      exposeNewDevices: true,
      quality: 'auto',
      hksv: true,
    })
  })

  // The remaining `.default()`s in the schema. Each is a value the plugin runs
  // on, and each is invisible to every test that supplies the field explicitly.
  it('applies the top-level defaults for name and devices', () => {
    const result = parseConfig({ platform: 'UniFiProtect', host: '10.0.0.1', apiKey: 'k' })
    expect(result.success && result.data.name).toBe('UniFi Protect')
    expect(result.success && result.data.devices).toEqual({})
    // ...and an explicit value is still taken, not overwritten by the default.
    const named = parseConfig({ ...minimal, name: 'Garage Console' })
    expect(named.success && named.data.name).toBe('Garage Console')
  })

  it('accepts a per-camera quality override', () => {
    const parsed = parseConfig({ ...minimal, devices: { cam1: { quality: 'high' } } })
    expect(parsed.success).toBe(true)
  })

  // Written out explicitly by the settings UI, which saves the default it read
  // rather than omitting it. Zod does NOT re-validate a `.default()` value, so
  // dropping 'auto' from the enum would leave every other test green while
  // rejecting the config of anyone who has ever opened the settings page.
  it('accepts an explicit auto quality, per camera and as the global default', () => {
    expect(parseConfig({ ...minimal, devices: { cam1: { quality: 'auto' } } }).success).toBe(true)
    const parsed = parseConfig({ ...minimal, defaults: { quality: 'auto' } })
    expect(parsed.success && settingsFor(parsed.data, 'cam1').quality).toBe('auto')
  })

  it('rejects a nonsense quality', () => {
    const parsed = parseConfig({ ...minimal, devices: { cam1: { quality: 'ultra' } } })
    expect(parsed.success).toBe(false)
  })

  it('accepts the global streaming settings and rejects an out-of-range stream cap', () => {
    const parsed = parseConfig({ ...minimal, maxStreams: 4, ffmpegPath: '/opt/ffmpeg' })
    expect(parsed.success && parsed.data.maxStreams).toBe(4)
    expect(parsed.success && parsed.data.ffmpegPath).toBe('/opt/ffmpeg')
    // A cap of zero would advertise cameras that can never stream; 100 would
    // let HomeKit ask for 100 concurrent HEVC transcodes.
    expect(parseConfig({ ...minimal, maxStreams: 0 }).success).toBe(false)
    expect(parseConfig({ ...minimal, maxStreams: 100 }).success).toBe(false)
    expect(parseConfig({ ...minimal, maxStreams: 2.5 }).success).toBe(false)
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
      quality: 'auto',
      hksv: false,
    })
  })

  it('leaves hksv off by default — the 50GB iCloud plan supports only one camera', () => {
    expect(settingsFor(data, 'unseen').hksv).toBe(false)
  })

  // Recording audio is legally more restricted than video in many places, and
  // an outdoor camera hears passers-by who have not consented. It must never
  // become true because a camera simply exists in the config.
  it('defaults audio off for a camera that does not ask for it', () => {
    const parsed = parseConfig({ ...minimal, devices: { cam1: {} } })
    expect(parsed.success && settingsFor(parsed.data, 'cam1').audio).toBe(false)
    expect(settingsFor(data, 'unseen').audio).toBe(false)
  })

  it('honours a per-camera audio opt-in', () => {
    const parsed = parseConfig({ ...minimal, devices: { cam1: { audio: true } } })
    expect(parsed.success && settingsFor(parsed.data, 'cam1').audio).toBe(true)
    // ...and only for that camera.
    expect(parsed.success && settingsFor(parsed.data, 'cam2').audio).toBe(false)
  })

  it('defaults packageCamera to false for a camera that does not set it', () => {
    const parsed = parseConfig({
      platform: 'UniFiProtect',
      host: 'h',
      apiKey: 'k',
      devices: { cam1: { quality: 'high' } },
    })
    expect(parsed.success && settingsFor(parsed.data, 'cam1').packageCamera).toBe(false)
  })

  it('accepts an explicit packageCamera opt-in', () => {
    const parsed = parseConfig({
      platform: 'UniFiProtect',
      host: 'h',
      apiKey: 'k',
      devices: { cam1: { packageCamera: true } },
    })
    expect(parsed.success && settingsFor(parsed.data, 'cam1').packageCamera).toBe(true)
  })

  it('rejects a non-boolean packageCamera', () => {
    const parsed = parseConfig({
      platform: 'UniFiProtect',
      host: 'h',
      apiKey: 'k',
      devices: { cam1: { packageCamera: 'yes' } },
    })
    expect(parsed.success).toBe(false)
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
