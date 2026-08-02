import type { StreamingDelegate } from '../src/accessories/streaming.js'
import type { ProtectPluginConfig } from '../src/config.js'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUDIO_LABEL } from '../homebridge-ui/public/config-ops.js'
import { UniFiProtectPlatform } from '../src/platform.js'
import { fingerprintOf } from '../src/protect/cert.js'
import { ProtectAuthError, ProtectUnavailableError } from '../src/protect/errors.js'
import { C, FakeAccessory, FakeDoorbellController, hap, S } from './fake-hap.js'
import { makeSelfSigned } from './support/tls.js'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() }

/** The five real cameras Task 0 captured off the live console. */
const cameras = JSON.parse(readFileSync('test/fixtures/cameras.json', 'utf8')) as Record<string, unknown>[]
function camera(name: string) {
  return cameras.find(c => c.name === name)!
}
/** Frames captured from the live event socket, verbatim. */
function frames(file: string): unknown[] {
  return (JSON.parse(readFileSync(`test/fixtures/events/${file}.json`, 'utf8')) as { payload: unknown }[]).map(f => f.payload)
}

/**
 * `deviceUpdate` frames, unlike `protectEvent` frames, are not wrapped in a
 * `payload` envelope — read verbatim as captured off the `devices` channel.
 */
function deviceUpdates(file: string): { type: string, item: Record<string, unknown> }[] {
  return JSON.parse(readFileSync(`test/fixtures/events/${file}.json`, 'utf8'))
}

class FakePlatformAccessory extends FakeAccessory {
  context: Record<string, unknown> = {}
  constructor(public displayName: string, public UUID: string) {
    super()
  }
}

function makeApi() {
  const api = new EventEmitter() as never as Record<string, unknown> & EventEmitter
  Object.assign(api, {
    hap: { ...hap, uuid: { generate: (s: string) => `uuid-${s}` } },
    platformAccessory: FakePlatformAccessory,
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
    patchCamera: vi.fn(async () => ({})),
    /**
     * Present so a call during discovery is VISIBLE, not so one is expected:
     * this is a POST that creates a stream on the console, and discovery must
     * never make it. Live view calls it when a viewer actually opens.
     */
    createRtspsStream: vi.fn(async (id: string, qualities: string[]) =>
      Object.fromEntries(qualities.map(q => [q, `rtsps://10.0.0.1:7441/${id}-${q}?token=SECRET`]))),
    getRtspsStream: vi.fn(async () => ({})),
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

/** What the reference host's `/usr/bin/ffmpeg` actually reports. */
const FFMPEG_CAPS = { path: '/usr/bin/ffmpeg', encoder: 'h264_vaapi' as const, hwaccel: 'vaapi' as const }

/**
 * An `-encoders` listing shaped like the real one. The hardware build in the
 * target container carries libopus but not libfdk_aac.
 */
const ENCODERS_WITH_OPUS = [
  ' V..... h264_vaapi           H.264/AVC (VAAPI)',
  ' A..... libopus              libopus Opus',
].join('\n')

const ENCODERS_VIDEO_ONLY = ' V..... h264_vaapi           H.264/AVC (VAAPI)'

function makePlatform(config: unknown = validConfig, cameras: unknown[] = [], presented = CERT_A) {
  const api = makeApi()
  const platform = new UniFiProtectPlatform(log as never, config as never, api as never)
  const bus = events()
  platform.client = makeClient(cameras) as never
  platform.events = bus as never
  // Stubbed everywhere, for the same reason as the certificate reader: no test
  // in this suite may exec a binary off the machine it happens to run on.
  const probe = vi.fn(async () => FFMPEG_CAPS)
  platform.probeFfmpeg = probe as never
  const run = vi.fn(async (_path: string, _args: string[]) => ENCODERS_WITH_OPUS)
  platform.runFfmpeg = run
  // Stubbed everywhere: nothing in this suite may open a TLS socket to the
  // fictional 10.0.0.1, and a real attempt hangs the run until it times out.
  platform.readConsoleCert = vi.fn(async () => ({ pem: presented, fingerprint: fingerprintOf(presented) }))
  return { api, platform, bus, probe, run }
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

  // -------------------------------------------------------------------------
  // The event pipeline: protectEvent -> router -> tracker -> HAP services.
  // Driven by the frames Task 0 captured off the live console, verbatim.
  // -------------------------------------------------------------------------

  const DOORBELL = camera('Doorbell').id as string
  const DRIVEWAY = camera('Driveway').id as string
  const GARAGE = camera('Garage').id as string

  /** Discovers the five real cameras and hands back the wired platform. */
  async function withCameras(
    devices: unknown[] = cameras,
    options: { config?: unknown, probeFfmpeg?: () => Promise<unknown>, encoders?: string } = {},
  ) {
    const ctx = makePlatform(options.config ?? validConfig, devices)
    if (options.probeFfmpeg)
      ctx.platform.probeFfmpeg = options.probeFfmpeg as never
    if (options.encoders !== undefined)
      ctx.run.mockResolvedValue(options.encoders)
    await ctx.platform.discover()
    const sensor = (id: string, subtype: string) =>
      (ctx.platform.accessories.get(`uuid-${id}`) as unknown as FakeAccessory).getServiceById(S.MotionSensor, subtype)
    const detected = (id: string, subtype: string) => sensor(id, subtype)?.valueOf_(C.MotionDetected)
    const accessories = [...ctx.platform.accessories.values()] as unknown as FakePlatformAccessory[]
    return { ...ctx, sensor, detected, accessories, log }
  }

  /** The accessory the 2a `ring` Doorbell service belongs to. */
  const doorbellOf = (accessories: FakePlatformAccessory[]) => accessories.find(a => a.UUID === `uuid-${DOORBELL}`)!

  /**
   * The sensor subtypes `camera.ts` owns. The numeric ones belong to the
   * CameraController's RTP stream managements, which HAP creates and names by
   * index — they are nothing to do with the sensor builder.
   */
  const sensorSubtypes = (accessory: FakeAccessory) =>
    accessory.services.map(s => s.subtype).filter(s => s && !/^\d+$/.test(s)).sort()

  it('builds the sensor services for every exposed camera during discovery', async () => {
    const { platform } = await withCameras()

    const doorbell = platform.accessories.get(`uuid-${DOORBELL}`) as unknown as FakeAccessory
    expect(sensorSubtypes(doorbell)).toEqual(
      ['detect-animal', 'detect-package', 'detect-person', 'detect-vehicle', 'led', 'motion', 'ring'],
    )
    // Sidegate reports hasLedStatus: false and no speaker.
    const sidegate = platform.accessories.get(`uuid-${camera('Sidegate').id}`) as unknown as FakeAccessory
    expect(sensorSubtypes(sidegate)).toEqual(['detect-animal', 'detect-person', 'motion'])
  })

  it('rebuilds services on a later discovery when a detection type is disabled in protect', async () => {
    const { platform } = await withCameras()
    const driveway = platform.accessories.get(`uuid-${DRIVEWAY}`) as unknown as FakeAccessory
    expect(driveway.getServiceById(S.MotionSensor, 'detect-vehicle')).toBeDefined()

    platform.client = makeClient(cameras.map(c =>
      c.id === DRIVEWAY ? { ...c, smartDetectSettings: { objectTypes: ['person'], audioTypes: [] } } : c,
    )) as never
    await platform.discover()

    expect(driveway.getServiceById(S.MotionSensor, 'detect-vehicle')).toBeUndefined()
    expect(driveway.getServiceById(S.MotionSensor, 'detect-person')).toBeDefined()
  })

  // The Critical from Task 3, one layer up: `ProtectClient` returns the RAW
  // payload when cameraSchema fails, so a Ubiquiti field rename is a real
  // production input. The platform must not defeat the builder's floor.
  it('removes no services when a degraded discovery arrives', async () => {
    const { platform } = await withCameras()
    const doorbell = platform.accessories.get(`uuid-${DOORBELL}`) as unknown as FakeAccessory
    const before = [...doorbell.services]

    platform.client = makeClient(cameras.map(c => ({ id: c.id, name: c.name, modelKey: 'camera' }))) as never
    await platform.discover()

    expect(doorbell.services).toEqual(before)
  })

  it('drives a motion sensor from the captured motion frames', async () => {
    const { bus, detected } = await withCameras()
    const [start, end] = frames('motion')

    bus.emit('protectEvent', start)
    expect(detected(DOORBELL, 'motion')).toBe(true)

    bus.emit('protectEvent', end)
    expect(detected(DOORBELL, 'motion')).toBe(false)
  })

  it('drives the per-type sensor on the right camera from the captured smart-detect frames', async () => {
    const { bus, detected } = await withCameras()

    // Frame 0 is Driveway, frame 2 is the Doorbell — the same detection type on
    // two devices, so a handler that ignored `device` would light both.
    bus.emit('protectEvent', frames('smart-detect')[0])
    expect(detected(DRIVEWAY, 'detect-person')).toBe(true)
    expect(detected(DOORBELL, 'detect-person')).toBeFalsy()

    bus.emit('protectEvent', frames('smart-detect')[2])
    expect(detected(DOORBELL, 'detect-person')).toBe(true)
  })

  // Real hardware redelivers the end frame for one event id up to 3x with an
  // identical `end`. The tracker dedupes; this proves nothing upstream undoes it.
  it('survives the console redelivering an end frame three times', async () => {
    const { bus, detected } = await withCameras()
    const smart = frames('smart-detect')

    bus.emit('protectEvent', smart[2])
    expect(detected(DOORBELL, 'detect-person')).toBe(true)
    for (const frame of smart.slice(4, 7))
      bus.emit('protectEvent', frame)
    expect(detected(DOORBELL, 'detect-person')).toBe(false)

    // A fresh event after the redeliveries must still light the sensor — a
    // holder count driven negative by the extra ends would leave it dark.
    bus.emit('protectEvent', smart[2])
    expect(detected(DOORBELL, 'detect-person')).toBe(true)
  })

  it('fires the doorbell once and ignores the end frame 302 seconds later', async () => {
    const { platform, bus } = await withCameras()
    const doorbell = platform.accessories.get(`uuid-${DOORBELL}`) as unknown as FakeAccessory
    const ring = doorbell.getServiceById(S.Doorbell, 'ring')!
    const [press, lateEnd] = frames('ring')

    bus.emit('protectEvent', press)
    expect(ring.valueOf_(C.ProgrammableSwitchEvent)).toBe(C.ProgrammableSwitchEvent.SINGLE_PRESS)

    // Reset so a second press would be visible, then deliver the late end.
    ring.updateCharacteristic(C.ProgrammableSwitchEvent, null)
    bus.emit('protectEvent', lateEnd)
    expect(ring.valueOf_(C.ProgrammableSwitchEvent)).toBeNull()
  })

  it('ignores an event for an unknown device silently and tracks nothing for it', async () => {
    vi.useFakeTimers()
    try {
      const { bus, detected } = await withCameras()
      const [start] = frames('motion')
      // Discovery's own logging is not what this test is about.
      vi.clearAllMocks()

      expect(() => bus.emit('protectEvent', { ...(start as object), item: { ...(start as { item: object }).item, device: 'nope' } })).not.toThrow()

      expect(detected(DOORBELL, 'motion')).toBeFalsy()
      // A chime or an unadopted device emits these constantly — no log spam.
      expect(log.warn).not.toHaveBeenCalled()
      expect(log.info).not.toHaveBeenCalled()
      // And no failsafe timer: an unexposed camera streaming events all day must
      // not accumulate tracker entries for sensors that do not exist.
      expect(vi.getTimerCount()).toBe(0)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('does not throw out of the handler on a malformed frame', async () => {
    const { bus, detected } = await withCameras()

    for (const frame of [
      null,
      undefined,
      'nonsense',
      [],
      { item: { type: 5 } },
      { item: null },
      { type: 'add', item: { id: 1, device: DOORBELL, type: 'motion' } },
      { type: 'add', item: { id: 'e', device: DOORBELL, type: 'smartDetectZone', smartDetectTypes: 'person' } },
      { type: 'add', item: { id: 'e', device: DOORBELL, type: '__proto__' } },
    ])
      expect(() => bus.emit('protectEvent', frame), JSON.stringify(frame ?? null)).not.toThrow()

    expect(detected(DOORBELL, 'motion')).toBeFalsy()
  })

  // There is no `GET /v1/events` on this API: an event open across a dropped
  // socket can never be reconciled by polling, only assumed over.
  it('clears active sensors when the bus asks for a resync', async () => {
    const { bus, detected } = await withCameras()

    bus.emit('protectEvent', frames('motion')[0])
    expect(detected(DOORBELL, 'motion')).toBe(true)

    bus.emit('resyncRequired', 'events')

    expect(detected(DOORBELL, 'motion')).toBe(false)
  })

  it('clears a stranded sensor when the failsafe expires', async () => {
    vi.useFakeTimers()
    try {
      const { bus, detected } = await withCameras()
      bus.emit('protectEvent', frames('motion')[0])
      expect(detected(DOORBELL, 'motion')).toBe(true)

      await vi.advanceTimersByTimeAsync(121_000)

      expect(detected(DOORBELL, 'motion')).toBe(false)
    }
    finally {
      vi.useRealTimers()
    }
  })

  // `applyChanges` is called bare from a `setTimeout` (the failsafe) and bare
  // from a bus listener (resync). A throw in the first is an uncaught exception
  // and a process exit — Homebridge dies, not just the sensor — and in the
  // second it would skip the discovery that resync exists to trigger.
  it('survives a throw while applying changes on both the failsafe and resync paths', async () => {
    vi.useFakeTimers()
    try {
      const { platform, bus } = await withCameras()
      const doorbell = platform.accessories.get(`uuid-${DOORBELL}`) as unknown as FakeAccessory
      const boom = Object.assign(new Error('HAP exploded'), { cause: { apiKey: 'sk-live-DO-NOT-LOG' } })
      doorbell.getServiceById = () => {
        throw boom
      }

      bus.emit('protectEvent', frames('motion')[0])
      // Uncaught here = process exit. Fake timers rethrow it into this await.
      await vi.advanceTimersByTimeAsync(121_000)

      const before = (platform.client.getCameras as ReturnType<typeof vi.fn>).mock.calls.length
      bus.emit('protectEvent', frames('motion')[0])
      expect(() => bus.emit('resyncRequired', 'events')).not.toThrow()
      await vi.advanceTimersByTimeAsync(0)
      // The throw must not have skipped the discovery pass resync exists for.
      expect((platform.client.getCameras as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before)

      // Every logged argument a string, and the credential on `cause` nowhere
      // near the log — log.error(err) runs util.inspect, which walks it.
      for (const call of [...log.warn.mock.calls, ...log.error.mock.calls]) {
        for (const arg of call)
          expect(typeof arg).toBe('string')
        expect(call.join(' ')).not.toContain('sk-live-DO-NOT-LOG')
      }
      expect(JSON.stringify(log.warn.mock.calls)).toContain('HAP exploded')
    }
    finally {
      vi.useRealTimers()
    }
  })

  // Leaked failsafe timers keep the Node process alive and Homebridge never
  // finishes shutting down.
  it('stops the tracker on shutdown so no failsafe fires afterwards', async () => {
    vi.useFakeTimers()
    try {
      const { api, bus, detected } = await withCameras()
      bus.emit('protectEvent', frames('motion')[0])
      expect(detected(DOORBELL, 'motion')).toBe(true)
      // A timer must actually exist before shutdown, or "0 after" below could
      // pass against a tracker that never armed a failsafe at all.
      expect(vi.getTimerCount()).toBeGreaterThan(0)

      api.emit('shutdown')
      // Assert the cancellation immediately, before any advance: advancing
      // first would let a merely-leaked (not cancelled) timer fire and drain
      // itself from the pending queue, so getTimerCount() would read 0 either
      // way and the assertion would prove nothing.
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(600_000)

      // Untouched: the timer was cancelled, not merely late.
      expect(detected(DOORBELL, 'motion')).toBe(true)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('applies a rename delivered as a partial device update frame', async () => {
    const { platform, bus } = makePlatform(validConfig, [{ id: 'cam1', name: 'Doorbell', modelKey: 'camera' }])
    await platform.discover()

    bus.emit('deviceUpdate', { type: 'update', item: { id: 'cam1', modelKey: 'camera', name: 'Front Door' } })

    const accessory = platform.accessories.get('uuid-cam1')
    expect(accessory?.displayName).toBe('Front Door')
    expect(accessory?.context.device).toMatchObject({ id: 'cam1', name: 'Front Door', modelKey: 'camera' })
  })

  // The other half of Task 5: a change made in the Protect app, not Home.app,
  // must still reach the switch. Assert the characteristic's actual value, not
  // merely that the handler ran without throwing.
  //
  // Fix round 1: this test previously used a synthetic frame. Toggling a real
  // camera's LED while subscribed to the `devices` channel showed the console
  // sends only three keys — `id`, `modelKey`, `ledSettings` — no
  // `smartDetectSettings`, `featureFlags`, `name`, `mac` or `state`. A frame
  // with those keys is captured verbatim in
  // `test/fixtures/events/device-update-led.json` (Garage's real id). The full
  // `cameraSchema` rejects it outright; only a schema requiring `id` and
  // `modelKey` and leaving everything else optional can parse it.
  it('updates the LED switch from a real deviceUpdate frame changing ledSettings', async () => {
    const { platform, bus } = await withCameras()
    const garage = platform.accessories.get(`uuid-${GARAGE}`) as unknown as FakeAccessory
    const on = garage.getServiceById(S.Switch, 'led')!.getCharacteristic(C.On)
    // Garage's fixture ships ledSettings.isEnabled: false.
    expect(on.value).toBe(false)

    const [ledOn, ledOff] = deviceUpdates('device-update-led')
    bus.emit('deviceUpdate', ledOn)
    expect(on.value).toBe(true)

    bus.emit('deviceUpdate', ledOff)
    expect(on.value).toBe(false)
  })

  // The worst bug class in this repo: a partial nested delta must not read as
  // "everything else is now empty". `applyDeviceUpdate`'s merge is shallow
  // (`Object.assign`), so an update carrying a `smartDetectSettings` with only
  // `objectTypes` and no `audioTypes` would replace the cached full object
  // wholesale — exactly the shape `isUnderstood()` exists to floor.
  //
  // In practice the generated `smartDetectSettingsSchema` requires BOTH fields
  // whenever the key is present at all, so this frame is rejected as malformed
  // before the merge ever runs — a stronger guarantee than the floor catching
  // it after the fact. Either way, no service is removed; that is the property
  // this test pins.
  it('removes no service when a partial nested smartDetectSettings delta arrives', async () => {
    const { platform, bus } = await withCameras()
    const doorbell = platform.accessories.get(`uuid-${DOORBELL}`) as unknown as FakeAccessory
    const before = [...doorbell.services]
    expect(before.map(s => s.subtype).filter(Boolean)).toContain('detect-vehicle')

    // Real shape: only the changed field, no audioTypes alongside it.
    bus.emit('deviceUpdate', { type: 'update', item: { id: DOORBELL, modelKey: 'camera', smartDetectSettings: { objectTypes: ['person'] } } })

    expect(doorbell.services).toEqual(before)
    // Rejected upstream by the schema, not silently accepted and floored late.
    expect(JSON.stringify(log.debug.mock.calls)).toContain('malformed')
  })

  // The wire payload is what real hardware actually receives — a test that only
  // checks `setLed` was called with the right arguments would still pass if the
  // platform sent the wrong body to Protect.
  it('sends the exact ledSettings body to patchCamera when the switch is set', async () => {
    const { platform } = await withCameras()
    const doorbell = platform.accessories.get(`uuid-${DOORBELL}`) as unknown as FakeAccessory
    const on = doorbell.getServiceById(S.Switch, 'led')!.getCharacteristic(C.On)

    await on.setHandler!(true)

    expect(platform.client.patchCamera).toHaveBeenCalledWith(DOORBELL, { ledSettings: { isEnabled: true } })
  })

  // Fix round 2: the previous "partial nested delta" test never actually
  // reached `Object.assign` — the schema rejected it first. This one gets a
  // schema-valid frame PAST the schema and into the merge, and proves
  // `isUnderstood()` itself floors removal there: a real production path is a
  // camera whose earlier discovery already came back degraded (a Ubiquiti
  // field rename), so its cached device permanently lacks
  // `smartDetectSettings`/`featureFlags` — every later deviceUpdate frame
  // merges onto that same degraded cache, however innocuous.
  it('floors removal via isUnderstood() when a schema-valid update merges onto an already-degraded cache', async () => {
    const { platform, bus } = await withCameras()
    const doorbell = platform.accessories.get(`uuid-${DOORBELL}`) as unknown as FakePlatformAccessory
    const before = [...doorbell.services]
    expect(before.map(s => s.subtype).filter(Boolean)).toContain('detect-vehicle')

    // Simulate the cache already being degraded from an earlier discovery.
    // A fresh object, never mutate in place: `context.device` here is the
    // very object the `cameras` fixture array holds, shared by every test in
    // this file — deleting a field on it would corrupt every test that runs
    // afterwards.
    doorbell.context.device = { ...(doorbell.context.device as Record<string, unknown>), smartDetectSettings: undefined, featureFlags: undefined }

    // This frame is entirely schema-valid — a plain ledSettings change — so it
    // passes `schema.safeParse` and reaches `Object.assign`.
    bus.emit('deviceUpdate', { type: 'update', item: { id: DOORBELL, modelKey: 'camera', ledSettings: { isEnabled: true, welcomeLed: true, floodLed: true } } })

    expect(doorbell.services).toEqual(before)
    expect(JSON.stringify(log.warn.mock.calls)).toContain('keeping its existing sensors')
  })

  // Fix round 2: `setLed` must not leave the cache stale, or an unrelated
  // deviceUpdate frame arriving after a successful write rebuilds the switch
  // from the old cached value and visibly flips it back in Home.app — exactly
  // what the user is about to test by hand.
  it('keeps the LED switch on its new value after an unrelated deviceUpdate frame following a successful write', async () => {
    const { platform, bus } = await withCameras()
    const doorbell = platform.accessories.get(`uuid-${DOORBELL}`) as unknown as FakeAccessory
    const on = doorbell.getServiceById(S.Switch, 'led')!.getCharacteristic(C.On)
    expect(on.value).toBe(false)

    await on.setHandler!(true)
    // Real HAP commits the requested value itself once a `set` handler
    // resolves without throwing — the fake harness does not, so this mirrors
    // that commit before exercising what happens next.
    on.value = true

    // Unrelated: a rename frame that carries no ledSettings at all. If the
    // cache were still stale, re-diffing here would read the old
    // ledSettings.isEnabled: false and flip the switch back.
    bus.emit('deviceUpdate', { type: 'update', item: { id: DOORBELL, modelKey: 'camera', name: 'Front Door' } })

    expect(on.value).toBe(true)
  })

  // Final review M4: the optimistic cache covered `applyDeviceUpdate` but not
  // `reconcile`. Discovery runs on every resync and every retry, and its
  // inventory GET can already be in flight when the PATCH lands — so it comes
  // back carrying the pre-write ledSettings and `wireLed` pushes the old value
  // back onto the switch in front of the user.
  it('keeps the LED switch on its new value across a discovery whose read raced the write', async () => {
    const { platform } = await withCameras()
    const doorbell = platform.accessories.get(`uuid-${DOORBELL}`) as unknown as FakeAccessory
    const on = doorbell.getServiceById(S.Switch, 'led')!.getCharacteristic(C.On)
    expect(on.value).toBe(false)

    await on.setHandler!(true)
    // Real HAP commits the requested value once the handler resolves; the fake
    // does not, so mirror that commit before the racing discovery lands.
    on.value = true

    // The client still answers with the unmodified fixture — exactly what an
    // inventory read issued before the PATCH returns.
    await platform.discover()

    expect(on.value).toBe(true)
    expect(((doorbell as unknown as FakePlatformAccessory).context.device as { ledSettings: { isEnabled: boolean } }).ledSettings.isEnabled).toBe(true)
  })

  // Final review I1: `reconcile`'s `modelKey === 'camera'` guard was untested —
  // replacing it with `true` left the whole suite green. Without it a light,
  // sensor or chime grows a Motion sensor and enters the service removal loop,
  // the code path that has produced four Criticals in this repo.
  it('builds no camera services for a non-camera device during discovery', async () => {
    const light = { id: 'light1', name: 'Porch', modelKey: 'light', featureFlags: { hasSpeaker: true, hasLedStatus: true }, smartDetectSettings: { objectTypes: ['person'], audioTypes: [] } }
    const { platform } = makePlatform(validConfig, [light])

    await platform.discover()

    const accessory = platform.accessories.get('uuid-light1') as unknown as FakeAccessory
    // Registered — otherwise this would pass without reconcile touching it.
    expect(accessory).toBeDefined()
    expect(accessory.services).toEqual([])
  })

  // Final review I1, the second call site: same guard in `applyDeviceUpdate`,
  // equally untested.
  it('builds and removes nothing when a deviceUpdate frame arrives for a non-camera accessory', async () => {
    const { platform, bus } = makePlatform(validConfig, [{ id: 'light1', name: 'Porch', modelKey: 'light' }])
    await platform.discover()
    const accessory = platform.accessories.get('uuid-light1') as unknown as FakePlatformAccessory
    // A service some other module owns, carrying a subtype camera.ts claims.
    // It must survive, and no camera service may appear beside it.
    const foreign = accessory.addService(S.MotionSensor, 'Porch Motion', 'motion')

    bus.emit('deviceUpdate', { type: 'update', item: { id: 'light1', modelKey: 'light', name: 'Porch Light' } })

    // The frame really was processed — without this the test would pass just
    // as well if the schema had rejected it before reaching the guard.
    expect(accessory.displayName).toBe('Porch Light')
    expect(accessory.services).toEqual([foreign])
  })

  // Fix round 2: `applyDeviceUpdate`'s own docblock promises nothing in here
  // throws back into the bare socket listener. `buildCameraServices` calls
  // straight into HAP (`addService`/`removeService`/`updateCharacteristic`),
  // any of which can throw on a HAP-level problem.
  it('does not throw out of applyDeviceUpdate when buildCameraServices throws', async () => {
    const { platform, bus } = await withCameras()
    const doorbell = platform.accessories.get(`uuid-${DOORBELL}`) as unknown as FakeAccessory
    const boom = Object.assign(new Error('HAP exploded'), { cause: { apiKey: 'sk-live-DO-NOT-LOG' } })
    doorbell.getServiceById = () => {
      throw boom
    }

    expect(() => bus.emit('deviceUpdate', { type: 'update', item: { id: DOORBELL, modelKey: 'camera', ledSettings: { isEnabled: true, welcomeLed: true, floodLed: true } } })).not.toThrow()

    for (const call of log.warn.mock.calls) {
      for (const arg of call)
        expect(typeof arg).toBe('string')
      expect(call.join(' ')).not.toContain('sk-live-DO-NOT-LOG')
    }
    expect(JSON.stringify(log.warn.mock.calls)).toContain('HAP exploded')
  })

  // -------------------------------------------------------------------------
  // Live streaming: the CameraController wiring.
  // -------------------------------------------------------------------------

  const controllerOf = (accessory: FakePlatformAccessory) => accessory.controllers[0]!
  const delegateOf = (accessory: FakePlatformAccessory) =>
    controllerOf(accessory).options.delegate as StreamingDelegate

  // Two execs per probe. Per camera that is ten on a five-camera console, and
  // it repeats on every resync — while the answer is a property of the host.
  it('probes ffmpeg once, not once per camera and not once per discovery', async () => {
    const probe = vi.fn(async () => FFMPEG_CAPS)
    const { platform, accessories } = await withCameras(cameras, { probeFfmpeg: probe })

    expect(accessories.length).toBeGreaterThan(1)
    expect(probe).toHaveBeenCalledTimes(1)

    await platform.discover()

    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('gives every camera exactly one bridged CameraController, and never a second one', async () => {
    const { api, platform, accessories } = await withCameras()

    expect(accessories).toHaveLength(5)
    for (const accessory of accessories) {
      expect(accessory.controllers, accessory.displayName).toHaveLength(1)
      // The host-wide default for the hardware encoder the probe reported.
      expect(controllerOf(accessory).options.cameraStreamCount).toBe(6)
    }

    // A rediscovery must not configure a second controller: that would duplicate
    // every stream management service on the accessory.
    await platform.discover()

    for (const accessory of accessories)
      expect(accessory.controllers, accessory.displayName).toHaveLength(1)
    // Every camera under the one child bridge. An external accessory is a
    // separate pairing the user would have to add by hand.
    expect(api.publishExternalAccessories).not.toHaveBeenCalled()
    expect(api.registerPlatformAccessories).toHaveBeenCalled()
  })

  /** Every camera in the fixture opts in to audio. */
  const audioForAll = { ...validConfig, devices: Object.fromEntries(cameras.map(c => [c.id as string, { audio: true }])) }

  // The shutdown handler is the only thing that kills a running transcode. A
  // throw from one delegate used to abandon every later one, plus the event bus
  // and the failsafe timers — the exact leaks the handler exists to prevent.
  it('finishes shutting down even when one delegate throws', async () => {
    const { api, bus, accessories } = await withCameras()
    const delegates = accessories.map(accessory => delegateOf(accessory))
    expect(delegates.length).toBeGreaterThan(1)

    delegates[0]!.stopAll = () => {
      throw new Error('kill failed')
    }
    const others = delegates.slice(1).map(delegate => vi.spyOn(delegate, 'stopAll'))

    api.emit('shutdown')

    for (const spy of others)
      expect(spy).toHaveBeenCalled()
    expect(bus.stop).toHaveBeenCalled()
    expect(log.warn.mock.calls.flat().join(' ')).toContain('kill failed')
  })

  // The guard before reconcile() runs before reconcile's own awaits, and
  // attaching five cameras awaits an encoder listing each time. Shutdown lands
  // there easily, and bringing the sockets back up afterwards is why Homebridge
  // would never finish exiting.
  it('does not restart the bus when shutdown lands during reconcile', async () => {
    const { api, platform, bus, run } = makePlatform(audioForAll, cameras)
    let release: (encoders: string) => void = () => {}
    run.mockImplementationOnce(async () => new Promise<string>((resolve) => {
      release = resolve
    }))

    const inFlight = platform.discover()
    await vi.waitFor(() => expect(run).toHaveBeenCalled())
    api.emit('shutdown')
    release(ENCODERS_WITH_OPUS)
    await inFlight

    expect(bus.stop).toHaveBeenCalled()
    expect(bus.start).not.toHaveBeenCalled()
  })

  // The advertisement must come from the delegate, which only offers a codec the
  // probed ffmpeg can actually encode. A hand-built block here would advertise
  // audio HomeKit then cannot play — and it would advertise it for every camera,
  // including the ones whose owner deliberately left audio off.
  it('advertises no audio for a camera that did not opt in', async () => {
    const { accessories } = await withCameras()
    const doorbell = doorbellOf(accessories)

    expect((controllerOf(doorbell).options.streamingOptions as { audio?: unknown }).audio).toBeUndefined()
    // HAP adds the Microphone service only when audio is advertised.
    expect(doorbell.services.some(s => s.type === S.Microphone)).toBe(false)
  })

  it('advertises the codec the probed ffmpeg can encode for a camera that opted in', async () => {
    const { accessories } = await withCameras(cameras, { config: audioForAll })
    const doorbell = doorbellOf(accessories)
    const advertised = (controllerOf(doorbell).options.streamingOptions as { audio?: { codecs: { type: string }[] } }).audio

    // OPUS, because the encoder list has libopus and not libfdk_aac — the
    // advertisement must name what the ffmpeg arguments will actually produce.
    expect(advertised?.codecs.map(c => c.type)).toEqual(['OPUS'])
    expect(doorbell.services.some(s => s.type === S.Microphone)).toBe(true)
  })

  // `ffmpeg -encoders` answers for the binary, not for a camera. Five cameras
  // meant five blocking execs, serially, on every discovery pass.
  it('lists the ffmpeg encoders once for the whole platform, not once per camera', async () => {
    const { platform, run } = await withCameras(cameras, { config: audioForAll })

    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[1]).toContain('-encoders')

    await platform.discover()

    expect(run).toHaveBeenCalledTimes(1)
  })

  // The silent failure this exists to explain: audio on in the config, an ffmpeg
  // that cannot encode either codec HomeKit accepts, and a user hearing nothing.
  it('says so in the log when audio is on but no codec can be advertised', async () => {
    const { accessories } = await withCameras(cameras, { config: audioForAll, encoders: ENCODERS_VIDEO_ONLY })
    const doorbell = doorbellOf(accessories)

    expect((controllerOf(doorbell).options.streamingOptions as { audio?: unknown }).audio).toBeUndefined()
    const warned = log.warn.mock.calls.flat().join(' ')
    expect(warned).toContain('Audio is enabled')
    expect(warned).toContain('libopus')
  })

  // HAP builds the audio TLVs and the Microphone service when the controller is
  // configured, and `CameraController.streamingOptions` is private and readonly,
  // so the advertisement cannot change afterwards. The documentation must say
  // "restart to enable audio" for exactly as long as that is true — this test is
  // what fails if someone makes it live without updating the docs, or writes
  // docs claiming it is live when it is not.
  it('cannot re-advertise audio for a camera switched on after the controller was attached', async () => {
    const { platform, accessories } = await withCameras()
    const doorbell = doorbellOf(accessories)
    expect((controllerOf(doorbell).options.streamingOptions as { audio?: unknown }).audio).toBeUndefined()

    const live = (platform as unknown as { config: ProtectPluginConfig }).config
    live.devices[DOORBELL] = { audio: true }
    await platform.discover()

    // Still video-only, and still exactly one controller — nothing re-attached.
    expect(controllerOf(doorbell).options.streamingOptions).toEqual(
      expect.objectContaining({ audio: undefined }),
    )
    expect(doorbell.controllers).toHaveLength(1)
    // The documentation must match the behaviour. The toggle's own label is what
    // the user reads before clicking, so assert the exported constant itself —
    // not the file's text, which the explanatory comment would satisfy on its own.
    expect(AUDIO_LABEL).toMatch(/restart/i)
  })

  it('advertises the configured maximum number of concurrent streams', async () => {
    const { accessories } = await withCameras(cameras, { config: { ...validConfig, maxStreams: 3 } })

    for (const accessory of accessories)
      expect(controllerOf(accessory).options.cameraStreamCount).toBe(3)
  })

  // Sub-project 2a already created the subtyped `ring` Doorbell and drives it
  // off the event pipeline. A DoorbellController brings its own, and the user
  // sees the doorbell twice in Home.app.
  it('adds no second doorbell service when the camera controller is attached', async () => {
    const { accessories } = await withCameras()
    const doorbell = doorbellOf(accessories)

    expect(doorbell.services.filter(s => s.type === S.Doorbell)).toHaveLength(1)
    expect(doorbell.getServiceById(S.Doorbell, 'ring')).toBeDefined()
    expect(controllerOf(doorbell)).not.toBeInstanceOf(FakeDoorbellController)
  })

  // The controller's own services carry a numeric subtype ("0", "1", ...), and
  // they are protected from `camera.ts`'s removal loop precisely by NOT being in
  // its OWNED_SUBTYPES allow-list. Adding them there would delete live view on
  // the second discovery.
  it('keeps the controller\'s stream management services across a discovery cycle', async () => {
    const { platform, accessories } = await withCameras()
    const doorbell = doorbellOf(accessories)
    const streaming = doorbell.services.filter(s => s.type === S.CameraRTPStreamManagement)
    expect(streaming).toHaveLength(6)

    await platform.discover()

    expect(doorbell.services.filter(s => s.type === S.CameraRTPStreamManagement)).toEqual(streaming)
  })

  it('gives a non-camera device no camera controller at all', async () => {
    const { platform } = makePlatform(validConfig, [{ id: 'light1', name: 'Porch', modelKey: 'light' }])

    await platform.discover()

    const light = platform.accessories.get('uuid-light1') as unknown as FakePlatformAccessory
    expect(light).toBeDefined()
    expect(light.controllers).toEqual([])
    expect(light.services).toEqual([])
  })

  // A stranded ffmpeg holds a 4 MP HEVC decode open for as long as the host is
  // up, and nothing else in the process will ever kill it.
  it('stops every camera\'s active streams on shutdown', async () => {
    const { api, accessories } = await withCameras()
    const stops = accessories.map(accessory => vi.spyOn(delegateOf(accessory), 'stopAll'))
    expect(stops).toHaveLength(5)

    api.emit('shutdown')

    for (const stop of stops)
      expect(stop).toHaveBeenCalledTimes(1)
  })

  // Sensors, switches and the doorbell are useful without live view — a host
  // with no usable ffmpeg must not lose them too.
  it('keeps sensors working when the ffmpeg probe fails', async () => {
    const boom = Object.assign(new Error('no usable ffmpeg'), { cause: { apiKey: 'sk-live-DO-NOT-LOG' } })
    const probe = vi.fn(async () => {
      throw boom
    })
    const { accessories } = await withCameras(cameras, { probeFfmpeg: probe })
    const doorbell = doorbellOf(accessories)

    expect(doorbell.services.some(s => s.subtype === 'motion')).toBe(true)
    expect(doorbell.getServiceById(S.Doorbell, 'ring')).toBeDefined()
    // No half-wired controller either.
    expect(doorbell.controllers).toEqual([])
    expect(log.warn.mock.calls.flat().join(' ')).toMatch(/ffmpeg/i)
    // Every logged argument a string, and the credential on `cause` nowhere near
    // the log — log.error(err) runs util.inspect, which walks it.
    for (const call of log.warn.mock.calls) {
      for (const arg of call)
        expect(typeof arg).toBe('string')
      expect(call.join(' ')).not.toContain('sk-live-DO-NOT-LOG')
    }
  })

  // Snapshotting the settings at construction would mean a quality or audio
  // change only took effect after a Homebridge restart.
  it('reads quality and audio from the live config on every stream request', async () => {
    const config = { ...validConfig, devices: { [DOORBELL]: { quality: 'low' } } }
    const { platform, accessories } = await withCameras(cameras, { config })
    const settings = () => (delegateOf(doorbellOf(accessories)) as unknown as {
      options: { settings: () => { quality: string, audio: boolean } }
    }).options.settings()

    expect(settings()).toEqual({ quality: 'low', audio: false })

    // What saving the settings page does: rewrite the config block in place.
    const live = (platform as unknown as { config: ProtectPluginConfig }).config
    live.devices[DOORBELL] = { quality: 'high', audio: true }

    expect(settings()).toEqual({ quality: 'high', audio: true })
  })

  // -------------------------------------------------------------------------
  // The package lens, as a second bridged accessory of its own.
  // -------------------------------------------------------------------------

  /** Only the Doorbell has the lens; Backyard is the control. */
  const BACKYARD = camera('Backyard').id as string
  const packageOn = (id: string) => ({ ...validConfig, devices: { [id]: { packageCamera: true } } })
  const PACKAGE_LABEL = 'Doorbell Package Camera'
  const packageOf = (accessories: FakePlatformAccessory[]) =>
    accessories.find(a => a.displayName === PACKAGE_LABEL)
  /** The accessories handed to a (un)register call, flattened out of the batches. */
  const registered = (fn: unknown) => (fn as { mock: { calls: unknown[][] } }).mock.calls.flat(2)

  it('adds a package accessory when the lens exists and the user opted in', async () => {
    const { api, accessories } = await withCameras(cameras, { config: packageOn(DOORBELL) })
    const pkg = packageOf(accessories)

    expect(pkg).toBeDefined()
    // Derived from the device id plus a suffix, so it can never collide with
    // the main accessory's — two accessories sharing a UUID is one accessory.
    expect(pkg!.UUID).toBe(`uuid-${DOORBELL}-package`)
    expect(pkg!.UUID).not.toBe(`uuid-${DOORBELL}`)
    expect(new Set(accessories.map(a => a.UUID)).size).toBe(accessories.length)
    // Bridged like everything else. An external accessory is a separate
    // pairing the user would have to add by hand.
    expect(api.publishExternalAccessories).not.toHaveBeenCalled()
    expect(registered(api.registerPlatformAccessories)).toContain(pkg)
    expect(pkg!.controllers).toHaveLength(1)
  })

  it('adds none when the lens exists but the setting is off', async () => {
    const { accessories } = await withCameras()

    expect(packageOf(accessories)).toBeUndefined()
    expect(accessories).toHaveLength(5)
  })

  it('adds none when the camera has no package lens, whatever the setting says', async () => {
    // The gate the whole feature rests on. Asserted on the fixture first, so a
    // green result cannot come from the fixture having drifted.
    expect(camera('Backyard').hasPackageCamera).toBe(false)

    const { accessories } = await withCameras(cameras, { config: packageOn(BACKYARD) })

    expect(accessories.map(a => a.displayName)).not.toContain('Backyard Package Camera')
    expect(accessories).toHaveLength(5)
  })

  // `ProtectClient` returns the RAW payload when cameraSchema validation fails,
  // so a Ubiquiti field rename is a real production input — and an absent flag
  // must read as "no lens", never as "assume yes".
  it('adds none when a degraded payload carries no lens flag at all', async () => {
    const degraded = cameras.map(c => ({ id: c.id, name: c.name, modelKey: 'camera' }))
    const { accessories } = await withCameras(degraded, { config: packageOn(DOORBELL) })

    expect(packageOf(accessories)).toBeUndefined()
  })

  // A camera and nothing else. The "Doorbell Package" motion sensor in
  // particular must stay on the MAIN accessory: moving a service between
  // accessories reads to HomeKit as the old one disappearing, which silently
  // breaks every automation built on it.
  it('adds no sensors, doorbell or led switch to the package accessory', async () => {
    const { accessories } = await withCameras(cameras, { config: packageOn(DOORBELL) })
    const pkg = packageOf(accessories)!

    expect(pkg.services.filter(s => s.type === S.MotionSensor)).toHaveLength(0)
    expect(pkg.services.filter(s => s.type === S.Doorbell)).toHaveLength(0)
    expect(pkg.services.filter(s => s.type === S.Switch)).toHaveLength(0)
    // Only what the CameraController itself brought.
    expect(sensorSubtypes(pkg)).toEqual([])
    // And the package motion sensor is still where it always was.
    expect(doorbellOf(accessories).getServiceById(S.MotionSensor, 'detect-package')).toBeDefined()
  })

  // Otherwise Home.app shows Default-Manufacturer/Model/Serial on its tile.
  it('populates AccessoryInformation on the package accessory, with its own serial', async () => {
    const { accessories } = await withCameras(cameras, { config: packageOn(DOORBELL) })
    const pkg = packageOf(accessories)!
    const main = doorbellOf(accessories)
    const info = pkg.getService(S.AccessoryInformation)!

    expect(info.valueOf_(C.Manufacturer)).toBe('Ubiquiti')
    expect(info.valueOf_(C.Model)).toBe('camera')
    expect(info.valueOf_(C.SerialNumber)).toBe(`${camera('Doorbell').mac}-package`)
    // Two bridged accessories sharing a serial is one accessory as far as
    // HomeKit's identity tracking is concerned.
    expect(info.valueOf_(C.SerialNumber)).not.toBe(main.getService(S.AccessoryInformation)!.valueOf_(C.SerialNumber))
  })

  // A degraded payload has no `mac` — writing a serial derived from the id
  // instead would make HomeKit treat the accessory as new the moment a real
  // payload arrives.
  it('does not set AccessoryInformation on the package accessory from a degraded payload', async () => {
    const degraded = cameras.map(c => ({ id: c.id, name: c.name, modelKey: 'camera', hasPackageCamera: true }))
    const { accessories } = await withCameras(degraded, { config: packageOn(DOORBELL) })
    const pkg = packageOf(accessories)!

    expect(pkg.getService(S.AccessoryInformation)).toBeUndefined()
  })

  // The lens is 1600x1200 — 4:3, unlike every other stream this plugin serves.
  // Advertising a 16:9 size would promise a frame it cannot produce.
  it('advertises 4:3 resolutions and no audio for the package lens', async () => {
    const config = { ...validConfig, devices: { [DOORBELL]: { packageCamera: true, audio: true } } }
    const { accessories } = await withCameras(cameras, { config })
    const pkg = packageOf(accessories)!
    const streaming = controllerOf(pkg).options.streamingOptions as {
      audio?: unknown
      video: { resolutions: number[][] }
    }

    // The exact ladder, not merely "some 4:3 sizes". A single non-conformant
    // entry made iOS refuse to negotiate at all, silently — hap-nodejs
    // validates neither the 24 fps floor nor the legal sizes.
    expect(streaming.video.resolutions).toEqual([
      [1920, 1440, 30],
      [1600, 1200, 30],
      [1280, 960, 30],
      [1024, 768, 30],
      [640, 480, 30],
      [480, 360, 30],
      [320, 240, 30],
    ])
    for (const [width, height, fps] of streaming.video.resolutions) {
      expect(width! / height!).toBeCloseTo(4 / 3)
      // HAP R2 11.8.1: every advertised stream must offer at least 24 fps.
      expect(fps!).toBeGreaterThanOrEqual(24)
    }
    // No audio even though this camera opted in: the lens shares the main
    // camera's microphone, so HAP must not create a Microphone service here.
    expect(streaming.audio).toBeUndefined()
    expect(pkg.services.some(s => s.type === S.Microphone)).toBe(false)
    // The main accessory still gets its audio — the package path must not
    // switch audio off for the camera itself.
    expect((controllerOf(doorbellOf(accessories)).options.streamingOptions as { audio?: unknown }).audio).toBeDefined()
  })

  it('streams the package channel, not a quality tier', async () => {
    const { accessories } = await withCameras(cameras, { config: packageOn(DOORBELL) })
    const options = (delegateOf(packageOf(accessories)!) as unknown as {
      options: { channel?: string, deviceId: string }
    }).options

    expect(options.channel).toBe('package')
    expect(options.deviceId).toBe(DOORBELL)
    // The main lens is untouched.
    expect((delegateOf(doorbellOf(accessories)) as unknown as { options: { channel?: string } }).options.channel)
      .toBeUndefined()
  })

  // A stranded ffmpeg holds a decode open for as long as the host is up.
  it('stops the package delegate on shutdown too', async () => {
    const { api, accessories } = await withCameras(cameras, { config: packageOn(DOORBELL) })
    const stop = vi.spyOn(delegateOf(packageOf(accessories)!), 'stopAll')

    api.emit('shutdown')

    expect(stop).toHaveBeenCalledTimes(1)
  })

  // The regression this design exists to prevent. Detecting the lens by asking
  // the console means `POST /cameras/{id}/rtsps-stream {qualities:["package"]}`,
  // which CREATES a stream — a state-changing request against every camera on
  // every startup, to learn something the inventory payload already carries.
  it('makes no console request to detect the package lens', async () => {
    const config = { ...validConfig, devices: Object.fromEntries(cameras.map(c => [c.id as string, { packageCamera: true }])) }
    const { platform, accessories } = await withCameras(cameras, { config })
    const client = (platform as unknown as { client: ReturnType<typeof makeClient> }).client

    // The Doorbell still got its accessory, so this is not passing by doing
    // nothing at all.
    expect(packageOf(accessories)).toBeDefined()
    expect(client.createRtspsStream).not.toHaveBeenCalled()
    expect(client.getRtspsStream).not.toHaveBeenCalled()

    await platform.discover()

    expect(client.createRtspsStream).not.toHaveBeenCalled()
    // And still exactly one controller on the package accessory — a second
    // would duplicate every stream management service on it.
    expect(packageOf(accessories)!.controllers).toHaveLength(1)
  })

  // Nothing in the console inventory carries the package UUID, so the removal
  // sweep sees it as a device that vanished — and unregistering is
  // irreversible: HomeKit rooms, scenes and automations do not come back.
  it('keeps the package accessory across later discoveries', async () => {
    const { api, platform, accessories } = await withCameras(cameras, { config: packageOn(DOORBELL) })
    const pkg = packageOf(accessories)!
    platform.confirmRemovalAfterMs = 0

    await platform.discover()
    await platform.discover()

    expect(platform.accessories.get(pkg.UUID)).toBe(pkg)
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled()
  })

  // A transient outage (ffmpeg missing at startup) must not cost an
  // already-registered package accessory its HomeKit room/scene/automation
  // membership. Main camera accessories get the same treatment in this
  // situation — they just end up controller-less.
  it('keeps an already-registered package accessory across a startup with no usable ffmpeg, controller-less', async () => {
    const config = packageOn(DOORBELL)
    const { accessories } = await withCameras(cameras, { config })
    const pkg = packageOf(accessories)!
    expect(pkg.controllers).toHaveLength(1)

    // A fresh platform models the next startup: the accessory cache already
    // has the package accessory (Homebridge restores it from its own cache
    // on disk), but this run's ffmpeg probe fails.
    const probe = vi.fn(async () => {
      throw new Error('no usable ffmpeg')
    })
    const restarted = makePlatform(config, cameras)
    restarted.platform.probeFfmpeg = probe as never
    restarted.platform.accessories.set(pkg.UUID, pkg as never)

    await restarted.platform.discover()

    expect(restarted.platform.accessories.has(pkg.UUID)).toBe(true)
    expect(restarted.api.unregisterPlatformAccessories).not.toHaveBeenCalled()
    // No second controller wired on top of the one already there.
    expect(pkg.controllers).toHaveLength(1)
  })

  /** The same "next startup, ffmpeg gone" model, with the accessory restored. */
  async function restartWithoutFfmpeg(config: unknown, devices: unknown[], pkg: FakePlatformAccessory) {
    const restarted = makePlatform(config, devices)
    restarted.platform.probeFfmpeg = (async () => {
      throw new Error('no usable ffmpeg')
    }) as never
    restarted.platform.accessories.set(pkg.UUID, pkg as never)
    await restarted.platform.discover()
    return restarted
  }

  // The retention guard above must never outrank the opt-out: unticking the
  // toggle is the user's explicit instruction, and a missing ffmpeg is no
  // reason to keep an accessory they asked to be rid of.
  it('removes the package accessory when the setting is off, even with ffmpeg unusable', async () => {
    const { accessories } = await withCameras(cameras, { config: packageOn(DOORBELL) })
    const pkg = packageOf(accessories)!

    const off = { ...validConfig, devices: { [DOORBELL]: { packageCamera: false } } }
    const restarted = await restartWithoutFfmpeg(off, cameras, pkg)

    expect(restarted.platform.accessories.has(pkg.UUID)).toBe(false)
    expect(registered(restarted.api.unregisterPlatformAccessories)).toContain(pkg)
  })

  // And the same for the lens genuinely being gone from the console's answer.
  it('removes the package accessory when hasPackageCamera flips to false, even with ffmpeg unusable', async () => {
    const config = packageOn(DOORBELL)
    const { accessories } = await withCameras(cameras, { config })
    const pkg = packageOf(accessories)!

    const lensGone = cameras.map(c => (c.id === DOORBELL ? { ...c, hasPackageCamera: false } : c))
    const restarted = await restartWithoutFfmpeg(config, lensGone, pkg)

    expect(restarted.platform.accessories.has(pkg.UUID)).toBe(false)
    expect(registered(restarted.api.unregisterPlatformAccessories)).toContain(pkg)
  })

  // Renaming the camera in Protect must not leave the package accessory behind
  // under the old name — it is a separate accessory with its own displayName.
  it('renames the package accessory when the parent camera is renamed', async () => {
    const config = packageOn(DOORBELL)
    const { api, platform, accessories } = await withCameras(cameras, { config })
    const pkg = packageOf(accessories)!
    expect(pkg.displayName).toBe('Doorbell Package Camera')

    const client = (platform as unknown as { client: ReturnType<typeof makeClient> }).client
    client.getCameras.mockResolvedValueOnce(cameras.map(c => (c.id === DOORBELL ? { ...c, name: 'Front Door' } : c)))
    await platform.discover()

    expect(pkg.displayName).toBe('Front Door Package Camera')
    expect(registered(api.updatePlatformAccessories)).toContain(pkg)
  })

  // No pre-existing accessory and no usable ffmpeg: there is nothing to keep
  // and nothing worth creating controller-less.
  it('registers no package accessory when ffmpeg is unusable and none existed yet', async () => {
    const probe = vi.fn(async () => {
      throw new Error('no usable ffmpeg')
    })
    const { accessories } = await withCameras(cameras, { config: packageOn(DOORBELL), probeFfmpeg: probe })

    expect(packageOf(accessories)).toBeUndefined()
  })

  // The user's own explicit instruction, exactly like `expose: false` — so it
  // takes effect now rather than waiting out the confirmation window meant for
  // a console answering mid-reboot.
  it('removes the package accessory and stops its ffmpeg when the setting is switched off', async () => {
    const { api, platform, accessories } = await withCameras(cameras, { config: packageOn(DOORBELL) })
    const pkg = packageOf(accessories)!
    const stop = vi.spyOn(delegateOf(pkg), 'stopAll')

    const live = (platform as unknown as { config: ProtectPluginConfig }).config
    live.devices[DOORBELL] = { packageCamera: false }
    await platform.discover()

    expect(platform.accessories.has(pkg.UUID)).toBe(false)
    expect(registered(api.unregisterPlatformAccessories)).toContain(pkg)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  // A genuine removal, unlike the no-ffmpeg case above: the lens itself is
  // gone from the console's answer, present ffmpeg or not, and must not wait
  // out the confirmation window.
  it('removes the package accessory when hasPackageCamera flips to false, even with ffmpeg present', async () => {
    const config = packageOn(DOORBELL)
    const { api, platform, accessories } = await withCameras(cameras, { config })
    const pkg = packageOf(accessories)!
    const stop = vi.spyOn(delegateOf(pkg), 'stopAll')

    const client = (platform as unknown as { client: ReturnType<typeof makeClient> }).client
    client.getCameras.mockResolvedValueOnce(cameras.map(c => (c.id === DOORBELL ? { ...c, hasPackageCamera: false } : c)))
    await platform.discover()

    expect(platform.accessories.has(pkg.UUID)).toBe(false)
    expect(registered(api.unregisterPlatformAccessories)).toContain(pkg)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  // One camera failing must not abort discovery for every other device.
  it('keeps discovering when the package accessory cannot be wired up', async () => {
    const config = { ...validConfig, devices: Object.fromEntries(cameras.map(c => [c.id as string, { packageCamera: true }])) }
    const { platform, api } = makePlatform(config, cameras)
    const boom = Object.assign(new Error('controller refused'), { cause: { apiKey: 'sk-live-DO-NOT-LOG' } })
    class Exploding extends FakePlatformAccessory {
      configureController(controller: never) {
        if (this.displayName.endsWith('Package Camera'))
          throw boom
        super.configureController(controller)
      }
    }
    api.platformAccessory = Exploding

    await platform.discover()

    // The load-bearing half of the `return uuid` after the catch: the package
    // accessory is registered and SURVIVES the removal sweep controller-less.
    // Nothing in the console inventory carries its UUID, so without that return
    // the sweep would unregister it over a transient wiring failure.
    const pkg = [...platform.accessories.values()].find(a => a.displayName === 'Doorbell Package Camera')!
    expect(pkg).toBeDefined()
    expect((pkg as unknown as FakeAccessory).controllers).toHaveLength(0)
    platform.confirmRemovalAfterMs = 0
    await platform.discover()
    await platform.discover()
    expect(platform.accessories.has(pkg.UUID)).toBe(true)
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled()

    // Every camera still reached HomeKit, controller and all.
    expect(platform.accessories.get(`uuid-${DOORBELL}`)).toBeDefined()
    expect((platform.accessories.get(`uuid-${DRIVEWAY}`) as unknown as FakeAccessory).controllers).toHaveLength(1)
    expect(log.warn.mock.calls.flat().join(' ')).toContain('controller refused')
    // The credential on `cause` nowhere near the log — log.error(err) runs
    // util.inspect, which walks it.
    for (const call of log.warn.mock.calls) {
      for (const arg of call)
        expect(typeof arg).toBe('string')
      expect(call.join(' ')).not.toContain('sk-live-DO-NOT-LOG')
    }
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
