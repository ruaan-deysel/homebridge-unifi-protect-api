import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UniFiProtectPlatform } from '../src/platform.js'
import { fingerprintOf } from '../src/protect/cert.js'
import { ProtectAuthError, ProtectUnavailableError } from '../src/protect/errors.js'
import { makeSelfSigned } from './support/tls.js'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() }

function makeApi() {
  const api = new EventEmitter() as never as Record<string, unknown> & EventEmitter
  Object.assign(api, {
    hap: { uuid: { generate: (s: string) => `uuid-${s}` } },
    platformAccessory: class { constructor(public displayName: string, public UUID: string) {} context: Record<string, unknown> = {} },
    registerPlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
    updatePlatformAccessories: vi.fn(),
    publishExternalAccessories: vi.fn(),
  })
  return api
}

const validConfig = { platform: 'UniFiProtect', name: 'UniFi Protect', host: '10.0.0.1', apiKey: 'k' }

/**
 * Routes by `modelKey` rather than hardcoding `[]` for everything but cameras —
 * otherwise no test ever reconciles a non-camera device and dropping any of the
 * four other endpoints from fetchInventory() stays green.
 */
function makeClient(devices: unknown[]) {
  const of = (modelKey: string) => devices.filter(d => (d as { modelKey?: string })?.modelKey === modelKey)
  return {
    getMetaInfo: vi.fn(async () => ({ applicationVersion: '7.1.87' })),
    getCameras: vi.fn(async () => of('camera')),
    getLights: vi.fn(async () => of('light')),
    getSensors: vi.fn(async () => of('sensor')),
    getChimes: vi.fn(async () => of('chime')),
    getViewers: vi.fn(async () => of('viewer')),
  }
}

const events = () => Object.assign(new EventEmitter(), { start: vi.fn(), stop: vi.fn() })

/**
 * PEMs the fake cert reader hands back. Real ones — `fingerprintOf` hashes the
 * DER, so a made-up string would compare equal to any other made-up string and
 * the mismatch test would pass for the wrong reason.
 */
const CERT_A = makeSelfSigned('console-a').cert
const CERT_B = makeSelfSigned('console-b').cert
const FP_A = fingerprintOf(CERT_A)
const FP_B = fingerprintOf(CERT_B)

function makePlatform(config: unknown = validConfig, cameras: unknown[] = [], presented = CERT_A) {
  const api = makeApi()
  const platform = new UniFiProtectPlatform(log as never, config as never, api as never)
  const bus = events()
  platform.client = makeClient(cameras) as never
  platform.events = bus as never
  // Stubbed everywhere: nothing in this suite may open a TLS socket to the
  // fictional 10.0.0.1, and a real attempt hangs the run until it times out.
  platform.readConsoleCert = vi.fn(async () => ({ pem: presented, fingerprint: fingerprintOf(presented) }))
  return { api, platform, bus }
}

describe('uniFiProtectPlatform', () => {
  beforeEach(() => vi.clearAllMocks())

  it('refuses to start on an invalid config', async () => {
    const { api, platform } = makePlatform({ platform: 'UniFiProtect' })
    await platform.discover()

    expect(log.error).toHaveBeenCalled()
    expect(JSON.stringify(log.error.mock.calls)).toContain('host')
    expect(api.registerPlatformAccessories).not.toHaveBeenCalled()
  })

  // Nothing else in the suite drives discovery the way Homebridge does. Without
  // this, deleting the `didFinishLaunching` subscription leaves every test green
  // while the plugin discovers nothing at all on a real boot.
  it('discovers when Homebridge emits didFinishLaunching', async () => {
    const { api, platform } = makePlatform(validConfig, [{ id: 'cam1', name: 'Doorbell', modelKey: 'camera' }])

    api.emit('didFinishLaunching')

    await vi.waitFor(() => expect(platform.accessories.has('uuid-cam1')).toBe(true))
  })

  // discoverSafely's catch is the only thing between a throwing discovery and a
  // Node >= 15 unhandled rejection taking all of Homebridge down with it.
  it('swallows a rejecting discovery and schedules a retry instead of dying', async () => {
    const { api, platform } = makePlatform(validConfig, [{ id: 'cam1', name: 'Doorbell', modelKey: 'camera' }])
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    api.registerPlatformAccessories = vi.fn(() => {
      throw new Error('hap exploded')
    })

    try {
      api.emit('didFinishLaunching')
      await vi.waitFor(() => expect(log.error).toHaveBeenCalled())
      // Let any unhandled rejection surface before we assert none did.
      await new Promise(resolve => setImmediate(resolve))

      expect(unhandled).not.toHaveBeenCalled()
      expect(JSON.stringify(log.error.mock.calls)).toContain('hap exploded')
      // F4: without a retry here the plugin is blind forever — no bus, no polling.
      expect(JSON.stringify(log.info.mock.calls)).toContain('Retrying discovery')
    }
    finally {
      process.off('unhandledRejection', unhandled)
      platform.accessories.clear()
      api.emit('shutdown')
    }
  })

  it('registers one bridged accessory per exposed device', async () => {
    const { api, platform } = makePlatform(validConfig, [{ id: 'cam1', name: 'Doorbell', modelKey: 'camera' }])

    await platform.discover()

    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1)
    expect(api.publishExternalAccessories).not.toHaveBeenCalled()
  })

  it('does not register a device the user excluded', async () => {
    const config = { ...validConfig, devices: { cam1: { expose: false } } }
    const { api, platform } = makePlatform(config, [{ id: 'cam1', name: 'Doorbell', modelKey: 'camera' }])

    await platform.discover()

    expect(api.registerPlatformAccessories).not.toHaveBeenCalled()
  })

  it('unregisters a device that vanished, but only once the confirmation window has passed', async () => {
    const survivor = { id: 'cam2', name: 'Garage', modelKey: 'camera' }
    const { api, platform } = makePlatform(validConfig, [{ id: 'cam1', name: 'Doorbell', modelKey: 'camera' }, survivor])
    // A zero window still requires a *later* discovery — the first sighting of
    // a missing device only records when it went missing. Shortened rather than
    // faked with timers so the test reads as "no waiting", not "an hour later".
    platform.confirmRemovalAfterMs = 0
    await platform.discover()

    platform.client = makeClient([survivor]) as never
    await platform.discover()

    // First disagreement: deferred, not deleted.
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled()
    expect(platform.accessories.has('uuid-cam1')).toBe(true)

    await platform.discover()

    expect(api.unregisterPlatformAccessories).toHaveBeenCalledTimes(1)
    expect(platform.accessories.has('uuid-cam1')).toBe(false)
  })

  // B2: the C1 guard was all-or-nothing while the deletion loop was per-device,
  // so a console answering mid-reboot with 1 of 20 devices wiped 19 of them.
  it('keeps accessories when a partial inventory drops most of them', async () => {
    const all = Array.from({ length: 20 }, (_, i) => ({ id: `cam${i}`, name: `Cam ${i}`, modelKey: 'camera' }))
    const { api, platform } = makePlatform(validConfig, all)
    await platform.discover()
    expect(platform.accessories.size).toBe(20)

    platform.client = makeClient([all[0]]) as never
    await platform.discover()

    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled()
    expect(platform.accessories.size).toBe(20)

    // ...and a device that reappears clears its deferral, so a flapping console
    // never accumulates its way to a deletion.
    platform.client = makeClient(all) as never
    await platform.discover()
    platform.client = makeClient([all[0]]) as never
    await platform.discover()

    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled()
    expect(platform.accessories.size).toBe(20)
  })

  // The gate must measure elapsed time, not count discoveries. `resyncRequired`
  // fires per channel on socket open and there are two channels, so a rebooting
  // console's reconnects deliver back-to-back passes — and a counting gate lets
  // the second one "confirm" the first from inside the very partial-inventory
  // window the gate exists to survive.
  it('does not unregister when a second discovery arrives inside the confirmation window', async () => {
    const all = Array.from({ length: 20 }, (_, i) => ({ id: `cam${i}`, name: `Cam ${i}`, modelKey: 'camera' }))
    const { api, platform } = makePlatform(validConfig, all)
    await platform.discover()
    expect(platform.accessories.size).toBe(20)

    // Both passes see the same partial inventory, seconds apart — the default
    // 60s window, not a shortened one.
    platform.client = makeClient([all[0]]) as never
    await platform.discover()
    await platform.discover()

    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled()
    expect(platform.accessories.size).toBe(20)
  })

  // A Pi has no battery-backed RTC: after a power cut it boots with a stale
  // clock and NTP steps it, often by hours and often within the first minute of
  // uptime — the exact window this gate exists to survive. On a wall clock that
  // step satisfies the window instantly and one partial inventory confirms
  // itself. Fails against `Date.now()`, for precisely that reason.
  it('is not fooled by an NTP step jumping the wall clock forward', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    try {
      const survivor = { id: 'cam2', name: 'Garage', modelKey: 'camera' }
      const { api, platform } = makePlatform(validConfig, [{ id: 'cam1', name: 'Doorbell', modelKey: 'camera' }, survivor])
      await platform.discover()

      platform.client = makeClient([survivor]) as never
      await platform.discover()

      // An hour of wall clock, no elapsed uptime.
      vi.setSystemTime(Date.now() + 3_600_000)
      await platform.discover()

      expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled()
      expect(platform.accessories.has('uuid-cam1')).toBe(true)
    }
    finally {
      vi.useRealTimers()
    }
  })

  // The counterweight to the test above: the gate must actually open, or it
  // would be satisfied by a plugin that simply never deletes anything.
  // `toFake: ['performance']` is required — vitest does not fake
  // `performance.now()` by default, and the gate reads a monotonic clock, so
  // `vi.setSystemTime` would move nothing and this test would pass vacuously.
  it('unregisters once a device has stayed missing past the confirmation window', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
    try {
      const survivor = { id: 'cam2', name: 'Garage', modelKey: 'camera' }
      const { api, platform } = makePlatform(validConfig, [{ id: 'cam1', name: 'Doorbell', modelKey: 'camera' }, survivor])
      await platform.discover()

      platform.client = makeClient([survivor]) as never
      await platform.discover()
      expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled()

      vi.advanceTimersByTime(61_000)
      await platform.discover()

      expect(api.unregisterPlatformAccessories).toHaveBeenCalledTimes(1)
      expect(platform.accessories.has('uuid-cam1')).toBe(false)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('reconciles lights, sensors, chimes and viewers, not only cameras', async () => {
    const { platform } = makePlatform(validConfig, [
      { id: 'cam1', name: 'Doorbell', modelKey: 'camera' },
      { id: 'light1', name: 'Floodlight', modelKey: 'light' },
      { id: 'sensor1', name: 'Door', modelKey: 'sensor' },
      { id: 'chime1', name: 'Hallway', modelKey: 'chime' },
      { id: 'viewer1', name: 'Wall', modelKey: 'viewer' },
    ])

    await platform.discover()

    expect([...platform.accessories.keys()].sort()).toEqual(
      ['uuid-cam1', 'uuid-chime1', 'uuid-light1', 'uuid-sensor1', 'uuid-viewer1'],
    )
  })

  it('unregisters a device the user has since excluded', async () => {
    const device = { id: 'cam1', name: 'Doorbell', modelKey: 'camera' }
    const { api, platform } = makePlatform(validConfig, [device])
    await platform.discover()
    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1)

    const excluded = makePlatform({ ...validConfig, devices: { cam1: { expose: false } } }, [device])
    for (const [uuid, accessory] of platform.accessories)
      excluded.platform.configureAccessory({ UUID: uuid, displayName: accessory.displayName, context: {} } as never)
    await excluded.platform.discover()

    expect(excluded.api.unregisterPlatformAccessories).toHaveBeenCalledTimes(1)
    expect(excluded.platform.accessories.size).toBe(0)
  })

  // C1: a discovery that "succeeds" with an empty inventory must never be
  // treated as authoritative — that path deleted every accessory irreversibly.
  it('keeps accessories when a successful discovery returns nothing at all', async () => {
    const { api, platform } = makePlatform(validConfig, [{ id: 'cam1', name: 'Doorbell', modelKey: 'camera' }])
    await platform.discover()
    expect(platform.accessories.size).toBe(1)

    platform.client = makeClient([]) as never
    await platform.discover()

    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled()
    expect(platform.accessories.size).toBe(1)
  })

  // N3: an array of id-less objects is as broken a response as an empty one.
  it('keeps accessories when every discovered device lacks an id', async () => {
    const { api, platform } = makePlatform(validConfig, [{ id: 'cam1', name: 'Doorbell', modelKey: 'camera' }])
    await platform.discover()

    platform.client = makeClient([{ name: 'Doorbell', modelKey: 'camera' }]) as never
    await platform.discover()

    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled()
    expect(platform.accessories.size).toBe(1)
  })

  it('keeps accessories when the console is unreachable', async () => {
    const { api, platform } = makePlatform(validConfig, [{ id: 'cam1', name: 'Doorbell', modelKey: 'camera' }])
    await platform.discover()

    const failing = makeClient([])
    failing.getCameras = vi.fn(async () => {
      throw new ProtectUnavailableError('down')
    })
    platform.client = failing as never
    await platform.discover()

    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled()
  })

  it('follows a rename without re-registering', async () => {
    const { api, platform } = makePlatform(validConfig, [{ id: 'cam1', name: 'Doorbell', modelKey: 'camera' }])
    await platform.discover()

    platform.client = makeClient([{ id: 'cam1', name: 'Front Door', modelKey: 'camera' }]) as never
    await platform.discover()

    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1)
    expect(api.updatePlatformAccessories).toHaveBeenCalled()
    expect(platform.accessories.get('uuid-cam1')?.displayName).toBe('Front Door')
  })

  it('skips a device the console returned without an id', async () => {
    const { api, platform } = makePlatform(validConfig, [
      { name: 'Nameless', modelKey: 'camera' },
      { id: 'cam1', name: 'Doorbell', modelKey: 'camera' },
    ])

    await expect(platform.discover()).resolves.toBeUndefined()

    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1)
    expect(platform.accessories.size).toBe(1)
  })

  it('names a device with no name after its id', async () => {
    const { platform } = makePlatform(validConfig, [{ id: 'cam1', name: null, modelKey: 'camera' }])
    await platform.discover()

    expect(platform.accessories.get('uuid-cam1')?.displayName).toBe('Protect camera cam1')
  })

  it('does not start the event bus when the api key is rejected', async () => {
    const { platform, bus } = makePlatform()
    const client = makeClient([])
    client.getMetaInfo = vi.fn(async () => {
      throw new ProtectAuthError('bad key')
    })
    platform.client = client as never

    await platform.discover()

    expect(bus.start).not.toHaveBeenCalled()
    expect(JSON.stringify(log.error.mock.calls)).toContain('Site Manager')
  })

  it('starts the event bus exactly once across repeated discovery', async () => {
    const { platform, bus } = makePlatform()
    await platform.discover()
    await platform.discover()

    expect(bus.start).toHaveBeenCalledTimes(1)
  })

  it('runs a fresh discovery when the bus asks for a resync', async () => {
    const { platform, bus } = makePlatform(validConfig, [{ id: 'cam1', name: 'Doorbell', modelKey: 'camera' }])
    await platform.discover()

    const second = makeClient([{ id: 'cam1', name: 'Doorbell', modelKey: 'camera' }])
    platform.client = second as never

    // The emit alone must drive it — no manual discover() call here, or the
    // test would pass with the handler deleted.
    bus.emit('resyncRequired', 'devices')

    await vi.waitFor(() => expect(second.getCameras).toHaveBeenCalled())
  })

  it('queues exactly one trailing pass for calls arriving mid-run', async () => {
    const { platform } = makePlatform()
    const client = makeClient([])
    platform.client = client as never

    await Promise.all([platform.discover(), platform.discover(), platform.discover()])

    // One run for the first caller, one trailing pass covering the other two.
    expect(client.getMetaInfo).toHaveBeenCalledTimes(2)
  })

  it('retries discovery after the console was unreachable', async () => {
    vi.useFakeTimers()
    try {
      const { platform } = makePlatform()
      const down = makeClient([])
      down.getMetaInfo = vi.fn(async () => {
        throw new ProtectUnavailableError('down')
      })
      platform.client = down as never
      await platform.discover()

      const up = makeClient([])
      platform.client = up as never
      await vi.advanceTimersByTimeAsync(20_000)

      expect(up.getMetaInfo).toHaveBeenCalled()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('lets a later discovery restart a bus that latched on an auth failure', async () => {
    const { platform, bus } = makePlatform()
    await platform.discover()
    expect(bus.start).toHaveBeenCalledTimes(1)

    bus.emit('authFailed', new ProtectAuthError('ws 401'))
    await platform.discover()

    expect(bus.start).toHaveBeenCalledTimes(2)
    // Wired once, however many times the bus is restarted.
    expect(bus.listenerCount('deviceUpdate')).toBe(1)
  })

  // N1: every retry here succeeds at REST, so resetting the backoff on success
  // turned this into a flat 15s loop forever.
  it('backs off between repeated websocket auth failures', async () => {
    vi.useFakeTimers()
    try {
      const { platform, bus } = makePlatform()
      await platform.discover()
      expect(bus.start).toHaveBeenCalledTimes(1)

      bus.emit('authFailed', new ProtectAuthError('ws 401'))
      await vi.advanceTimersByTimeAsync(15_000)
      expect(bus.start).toHaveBeenCalledTimes(2)

      // The second retry must wait 30s, not another 15.
      bus.emit('authFailed', new ProtectAuthError('ws 401'))
      await vi.advanceTimersByTimeAsync(20_000)
      expect(bus.start).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(15_000)
      expect(bus.start).toHaveBeenCalledTimes(3)
    }
    finally {
      vi.useRealTimers()
    }
  })

  // N2, success path: the guard at the top of runDiscovery runs before the
  // awaits, so a discovery that SUCCEEDS after shutdown fell straight through
  // to reconcile() and startEvents(). Rejecting instead of resolving here is
  // what let this survive two rounds of review.
  it('does not register or restart the bus when a discovery succeeds after shutdown', async () => {
    const { api, platform, bus } = makePlatform()
    let resolveMeta = (_: { applicationVersion: string }): void => {}
    const slow = makeClient([{ id: 'cam1', name: 'Doorbell', modelKey: 'camera' }])
    slow.getMetaInfo = vi.fn(() => new Promise<{ applicationVersion: string }>((resolve) => {
      resolveMeta = resolve
    }))
    platform.client = slow as never

    const inFlight = platform.discover()
    api.emit('shutdown')
    resolveMeta({ applicationVersion: '7.1.87' })
    await inFlight

    expect(bus.stop).toHaveBeenCalled()
    expect(bus.start).not.toHaveBeenCalled()
    expect(api.registerPlatformAccessories).not.toHaveBeenCalled()
    expect(platform.accessories.size).toBe(0)
  })

  // N2: a discovery in flight at shutdown could fail afterwards, schedule a
  // retry past the clearTimeout, and bring the sockets back up.
  it('never discovers or restarts the bus after shutdown', async () => {
    vi.useFakeTimers()
    try {
      const { api, platform, bus } = makePlatform()
      let fail = (_: unknown): void => {}
      const hanging = makeClient([])
      hanging.getMetaInfo = vi.fn(() => new Promise<never>((_, reject) => {
        fail = reject
      }))
      platform.client = hanging as never

      const inFlight = platform.discover()
      api.emit('shutdown')
      fail(new ProtectUnavailableError('down'))
      await inFlight

      expect(bus.stop).toHaveBeenCalled()

      const after = makeClient([])
      platform.client = after as never
      await vi.advanceTimersByTimeAsync(600_000)

      expect(after.getMetaInfo).not.toHaveBeenCalled()
      expect(bus.start).not.toHaveBeenCalled()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('survives a malformed device update frame', async () => {
    const { platform, bus } = makePlatform(validConfig, [{ id: 'cam1', name: 'Doorbell', modelKey: 'camera' }])
    await platform.discover()

    expect(() => bus.emit('deviceUpdate', { type: 'update', item: { id: 'cam1', modelKey: 'camera' } })).not.toThrow()
    expect(() => bus.emit('deviceUpdate', null)).not.toThrow()
    expect(() => bus.emit('deviceUpdate', { item: { modelKey: 'unicorn' } })).not.toThrow()
    // Inherited Object.prototype keys must not resolve to a "schema".
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])
      expect(() => bus.emit('deviceUpdate', { item: { id: 'cam1', modelKey: key } })).not.toThrow()
    expect(platform.accessories.get('uuid-cam1')?.displayName).toBe('Doorbell')
  })

  it('applies a rename delivered as a partial device update frame', async () => {
    const { platform, bus } = makePlatform(validConfig, [{ id: 'cam1', name: 'Doorbell', modelKey: 'camera' }])
    await platform.discover()

    bus.emit('deviceUpdate', { type: 'update', item: { id: 'cam1', modelKey: 'camera', name: 'Front Door' } })

    const accessory = platform.accessories.get('uuid-cam1')
    expect(accessory?.displayName).toBe('Front Door')
    expect(accessory?.context.device).toMatchObject({ id: 'cam1', name: 'Front Door', modelKey: 'camera' })
  })
})

describe('console certificate trust', () => {
  const camera = { id: 'cam1', name: 'Doorbell', modelKey: 'camera' }
  let dir: string
  let configPath: string

  beforeEach(() => {
    vi.clearAllMocks()
    dir = mkdtempSync(join(tmpdir(), 'protect-platform-test-'))
    configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ bridge: { name: 'Homebridge' }, platforms: [{ ...validConfig }] }, null, 4))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** Homebridge hands plugins the config path here; the test api has no `user`. */
  const withConfigPath = (api: Record<string, unknown>) => Object.assign(api, { user: { configPath: () => configPath } })

  it('trusts the certificate on first use, logs the fingerprint and saves it', async () => {
    const { api, platform } = makePlatform(validConfig, [camera], CERT_A)
    withConfigPath(api)

    await platform.discover()

    expect(JSON.stringify(log.info.mock.calls)).toContain(FP_A)
    expect(platform.client.consoleCert).toBe(CERT_A)
    expect(platform.events.consoleCert).toBe(CERT_A)
    // Written back to config.json, so the next start pins instead of re-trusting.
    const saved = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(saved.platforms[0].consoleCert).toBe(CERT_A)
    // And nothing else in the file was disturbed.
    expect(saved.bridge).toEqual({ name: 'Homebridge' })
  })

  it('pins silently on a later run when the certificate still matches', async () => {
    const { api, platform } = makePlatform({ ...validConfig, consoleCert: CERT_A }, [camera], CERT_A)
    withConfigPath(api)

    await platform.discover()

    expect(platform.client.consoleCert).toBe(CERT_A)
    expect(platform.accessories.has('uuid-cam1')).toBe(true)
    // No re-trust: the file is untouched and nothing announces a new fingerprint.
    expect(JSON.parse(readFileSync(configPath, 'utf8')).platforms[0].consoleCert).toBeUndefined()
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('Trusting')
  })

  it('fails closed when the certificate changed, without contacting the console', async () => {
    const { api, platform } = makePlatform({ ...validConfig, consoleCert: CERT_A }, [camera], CERT_B)
    withConfigPath(api)

    await platform.discover()

    // Not one request was made, so the API key was never offered.
    expect(platform.client.getMetaInfo).not.toHaveBeenCalled()
    expect(platform.client.consoleCert).toBeUndefined()
    // Nor were the subscriptions started — they carry the same header.
    expect(platform.events.start).not.toHaveBeenCalled()
    // Actionable: both fingerprints, and how to re-trust deliberately.
    const errors = JSON.stringify(log.error.mock.calls)
    expect(errors).toContain(FP_A)
    expect(errors).toContain(FP_B)
    expect(errors).toContain('Trust this certificate')
    // Nothing silently re-trusted itself.
    expect(JSON.parse(readFileSync(configPath, 'utf8')).platforms[0].consoleCert).toBeUndefined()
  })

  it('does not latch onto a mismatch on a later discovery either', async () => {
    const { api, platform } = makePlatform({ ...validConfig, consoleCert: CERT_A }, [camera], CERT_B)
    withConfigPath(api)

    await platform.discover()
    await platform.discover()

    expect(platform.client.getMetaInfo).not.toHaveBeenCalled()
  })

  it('retries rather than proceeding when the certificate cannot be read', async () => {
    const { api, platform } = makePlatform(validConfig, [camera])
    withConfigPath(api)
    platform.readConsoleCert = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })

    await platform.discover()

    expect(platform.client.getMetaInfo).not.toHaveBeenCalled()
    expect(JSON.stringify(log.info.mock.calls)).toContain('Retrying discovery')
    api.emit('shutdown')
  })

  it('still works for the session when config.json cannot be written', async () => {
    const { platform } = makePlatform(validConfig, [camera], CERT_A)
    // No `api.user` at all — the standalone/unusual Homebridge setups.

    await platform.discover()

    expect(platform.client.consoleCert).toBe(CERT_A)
    expect(platform.accessories.has('uuid-cam1')).toBe(true)
    expect(JSON.stringify(log.warn.mock.calls)).toContain('could not save it to config.json')
  })
})
