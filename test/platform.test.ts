import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UniFiProtectPlatform } from '../src/platform.js'
import { ProtectAuthError, ProtectUnavailableError } from '../src/protect/errors.js'

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

  it('unregisters a device that vanished, but only once two discoveries agree', async () => {
    const survivor = { id: 'cam2', name: 'Garage', modelKey: 'camera' }
    const { api, platform } = makePlatform(validConfig, [{ id: 'cam1', name: 'Doorbell', modelKey: 'camera' }, survivor])
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
