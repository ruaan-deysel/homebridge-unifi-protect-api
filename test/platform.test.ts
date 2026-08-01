import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UniFiProtectPlatform } from '../src/platform.js'
import { ProtectAuthError, ProtectUnavailableError } from '../src/protect/errors.js'
import { C, FakeAccessory, hap, S } from './fake-hap.js'

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
  }
}

const events = () => Object.assign(new EventEmitter(), { start: vi.fn(), stop: vi.fn() })

function makePlatform(config: unknown = validConfig, cameras: unknown[] = []) {
  const api = makeApi()
  const platform = new UniFiProtectPlatform(log as never, config as never, api as never)
  const bus = events()
  platform.client = makeClient(cameras) as never
  platform.events = bus as never
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

  // -------------------------------------------------------------------------
  // The event pipeline: protectEvent -> router -> tracker -> HAP services.
  // Driven by the frames Task 0 captured off the live console, verbatim.
  // -------------------------------------------------------------------------

  const DOORBELL = camera('Doorbell').id as string
  const DRIVEWAY = camera('Driveway').id as string
  const GARAGE = camera('Garage').id as string

  /** Discovers the five real cameras and hands back the wired platform. */
  async function withCameras(devices: unknown[] = cameras) {
    const ctx = makePlatform(validConfig, devices)
    await ctx.platform.discover()
    const sensor = (id: string, subtype: string) =>
      (ctx.platform.accessories.get(`uuid-${id}`) as unknown as FakeAccessory).getServiceById(S.MotionSensor, subtype)
    const detected = (id: string, subtype: string) => sensor(id, subtype)?.valueOf_(C.MotionDetected)
    return { ...ctx, sensor, detected }
  }

  it('builds the sensor services for every exposed camera during discovery', async () => {
    const { platform } = await withCameras()

    const doorbell = platform.accessories.get(`uuid-${DOORBELL}`) as unknown as FakeAccessory
    expect(doorbell.services.map(s => s.subtype).filter(Boolean).sort()).toEqual(
      ['detect-animal', 'detect-package', 'detect-person', 'detect-vehicle', 'led', 'motion', 'ring'],
    )
    // Sidegate reports hasLedStatus: false and no speaker.
    const sidegate = platform.accessories.get(`uuid-${camera('Sidegate').id}`) as unknown as FakeAccessory
    expect(sidegate.services.map(s => s.subtype).filter(Boolean).sort()).toEqual(['detect-animal', 'detect-person', 'motion'])
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

      api.emit('shutdown')
      await vi.advanceTimersByTimeAsync(600_000)

      // Untouched: the timer was cancelled, not merely late.
      expect(detected(DOORBELL, 'motion')).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
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

    await Promise.all(on.listeners('set').map(h => h(true)))

    expect(platform.client.patchCamera).toHaveBeenCalledWith(DOORBELL, { ledSettings: { isEnabled: true } })
  })
})
