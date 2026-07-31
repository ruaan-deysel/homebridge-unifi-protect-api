import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProtectEvents } from '../src/protect/events.js'

/** Minimal stand-in for a `ws` socket, driven manually by the tests. */
class FakeSocket extends EventEmitter {
  static instances: FakeSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  autoPong = true
  pings = 0
  terminated = false

  constructor(readonly url: string, readonly options?: unknown) {
    super()
    FakeSocket.instances.push(this)
  }

  open() {
    this.readyState = 1
    this.onopen?.()
  }

  send(data: unknown) {
    this.onmessage?.({ data })
  }

  fail(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code })
  }

  close() {
    // Mirrors `ws`: closing a CONNECTING socket aborts the handshake and emits
    // 'error'. With no listener attached, node rethrows it and kills the process.
    if (this.readyState === 0)
      this.emit('error', new Error('WebSocket was closed before the connection was established'))
    this.readyState = 3
  }

  /** A healthy peer answers pings. Set `autoPong = false` to simulate a half-open flow. */
  ping() {
    this.pings++
    if (this.autoPong)
      this.emit('pong')
  }

  terminate() {
    this.terminated = true
    this.fail(1006)
  }
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

function makeEvents() {
  return new ProtectEvents({
    host: '10.0.0.1',
    apiKey: 'SECRET-KEY',
    log,
    socketFactory: (url, options) => new FakeSocket(url, options) as never,
  })
}

describe('protectEvents', () => {
  beforeEach(() => {
    FakeSocket.instances = []
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => vi.useRealTimers())

  it('opens both subscriptions against the integration api', () => {
    const events = makeEvents()
    events.start()

    const urls = FakeSocket.instances.map(s => s.url)
    expect(urls).toContain('wss://10.0.0.1/proxy/protect/integration/v1/subscribe/devices')
    expect(urls).toContain('wss://10.0.0.1/proxy/protect/integration/v1/subscribe/events')
    events.stop()
  })

  it('sends the api key as a header and skips certificate verification', () => {
    const events = makeEvents()
    events.start()

    expect(FakeSocket.instances[0]!.options).toEqual({
      headers: { 'X-API-KEY': 'SECRET-KEY' },
      rejectUnauthorized: false,
      // Without this `ws` waits forever on a console that accepts the TCP
      // connection but never answers the upgrade.
      handshakeTimeout: 15_000,
    })
    events.stop()
  })

  it('emits parsed device updates', () => {
    const events = makeEvents()
    const seen: unknown[] = []
    events.on('deviceUpdate', payload => seen.push(payload))
    events.start()

    const devices = FakeSocket.instances[0]!
    devices.open()
    devices.send(JSON.stringify({ type: 'update', item: { id: 'cam1', modelKey: 'camera' } }))

    expect(seen).toEqual([{ type: 'update', item: { id: 'cam1', modelKey: 'camera' } }])
    events.stop()
  })

  it('emits protect events from the events subscription', () => {
    const events = makeEvents()
    const seen: unknown[] = []
    events.on('protectEvent', payload => seen.push(payload))
    events.start()

    const eventSocket = FakeSocket.instances[1]!
    eventSocket.open()
    eventSocket.send(Buffer.from(JSON.stringify({ type: 'add', item: { id: 'evt1' } })))

    expect(seen).toEqual([{ type: 'add', item: { id: 'evt1' } }])
    events.stop()
  })

  it('skips a malformed frame without closing the socket', () => {
    const events = makeEvents()
    const seen: unknown[] = []
    events.on('deviceUpdate', payload => seen.push(payload))
    events.start()
    const devices = FakeSocket.instances[0]!
    devices.open()

    devices.send('this is not json')
    devices.send(JSON.stringify({ type: 'update', item: { id: 'cam1' } }))

    expect(log.debug).toHaveBeenCalled()
    expect(devices.readyState).toBe(1)
    // The socket survived the bad frame and the next good one still arrived.
    expect(seen).toEqual([{ type: 'update', item: { id: 'cam1' } }])
    events.stop()
  })

  it('never logs the api key', () => {
    const events = makeEvents()
    events.start()
    const devices = FakeSocket.instances[0]!
    devices.open()
    devices.send('this is not json')
    devices.onerror?.(new Error('boom'))
    devices.fail()

    const lines = [log.info, log.warn, log.error, log.debug]
      .flatMap(fn => fn.mock.calls.flat())
      .join('\n')
    expect(lines).not.toContain('SECRET-KEY')
    events.stop()
  })

  it('reconnects with backoff and requests a resync, but not on first connect', async () => {
    const events = makeEvents()
    const resyncs: unknown[] = []
    events.on('resyncRequired', channel => resyncs.push(channel))
    events.start()

    const devices = FakeSocket.instances[0]!
    devices.open()
    expect(resyncs).toHaveLength(0) // first connect must NOT trigger a resync

    // Neither does the second channel's first connect.
    FakeSocket.instances[1]!.open()
    expect(resyncs).toHaveLength(0)

    devices.fail()
    const countAfterFail = FakeSocket.instances.length
    // Nothing reconnects instantly — the backoff has to elapse first.
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeSocket.instances).toHaveLength(countAfterFail)

    await vi.advanceTimersByTimeAsync(60_000)

    const reconnected = FakeSocket.instances.at(-1)!
    reconnected.open()
    expect(resyncs).toEqual(['devices'])
    events.stop()
  })

  it('backs off exponentially up to the cap', async () => {
    const events = makeEvents()
    events.start()
    const delays: number[] = []
    let previous = FakeSocket.instances.length

    for (let i = 0; i < 8; i++) {
      FakeSocket.instances.at(-1)!.fail()
      let waited = 0
      // Step forward a second at a time until the reconnect actually happens.
      while (FakeSocket.instances.length === previous && waited < 300_000) {
        await vi.advanceTimersByTimeAsync(1000)
        waited += 1000
      }
      delays.push(waited)
      previous = FakeSocket.instances.length
    }

    expect(delays.slice(0, 3)).toEqual([1000, 2000, 4000])
    expect(delays.at(-1)).toBe(60_000) // capped
    events.stop()
  })

  /** Advances the clock a second at a time until a new socket appears. Returns the wait. */
  async function waitForReconnect(previous: number) {
    let waited = 0
    while (FakeSocket.instances.length === previous && waited < 300_000) {
      await vi.advanceTimersByTimeAsync(1000)
      waited += 1000
    }
    return waited
  }

  it('keeps backing off when the console accepts then instantly drops the connection', async () => {
    const events = makeEvents()
    events.start()
    const delays: number[] = []
    let previous = FakeSocket.instances.length

    // A console mid-reboot, or a proxy under load: the upgrade succeeds and the
    // socket dies a moment later. Resetting the backoff on `open` would hammer
    // it at the floor delay forever.
    for (let i = 0; i < 4; i++) {
      const socket = FakeSocket.instances.at(-1)!
      socket.open()
      socket.fail()
      delays.push(await waitForReconnect(previous))
      previous = FakeSocket.instances.length
    }

    expect(delays).toEqual([1000, 2000, 4000, 8000])
    events.stop()
  })

  it('resets the backoff once a connection has held', async () => {
    const events = makeEvents()
    events.start()
    let previous = FakeSocket.instances.length

    FakeSocket.instances.at(-1)!.fail()
    expect(await waitForReconnect(previous)).toBe(1000)
    previous = FakeSocket.instances.length
    FakeSocket.instances.at(-1)!.fail()
    expect(await waitForReconnect(previous)).toBe(2000)
    previous = FakeSocket.instances.length

    // This one holds, so the next drop starts from the floor again.
    FakeSocket.instances.at(-1)!.open()
    await vi.advanceTimersByTimeAsync(35_000)
    FakeSocket.instances.at(-1)!.fail()

    expect(await waitForReconnect(previous)).toBe(1000)
    events.stop()
  })

  it('stops reconnecting after stop() and clears pending timers', async () => {
    const events = makeEvents()
    events.start()
    const devices = FakeSocket.instances[0]!
    devices.open()
    devices.fail()

    events.stop()
    const countAtStop = FakeSocket.instances.length
    await vi.advanceTimersByTimeAsync(120_000)

    expect(FakeSocket.instances.length).toBe(countAtStop)
  })

  it('stops the reconnect loop permanently when the console rejects the api key', async () => {
    const events = makeEvents()
    events.start()
    const devices = FakeSocket.instances[0]!

    devices.emit('unexpected-response', {}, { statusCode: 401 })
    devices.fail()
    FakeSocket.instances[1]!.fail()
    const countAtFailure = FakeSocket.instances.length
    await vi.advanceTimersByTimeAsync(600_000)

    expect(FakeSocket.instances).toHaveLength(countAtFailure)
    expect(log.error).toHaveBeenCalled()
  })

  it('keeps retrying after a non-auth handshake failure', async () => {
    const events = makeEvents()
    events.start()
    const devices = FakeSocket.instances[0]!

    devices.emit('unexpected-response', {}, { statusCode: 502 })
    devices.fail()
    const countAtFailure = FakeSocket.instances.length
    await vi.advanceTimersByTimeAsync(60_000)

    expect(FakeSocket.instances.length).toBeGreaterThan(countAtFailure)
    events.stop()
  })

  it('emits authFailed so the consumer can surface a rotated key', () => {
    const events = makeEvents()
    const failures: Error[] = []
    events.on('authFailed', error => failures.push(error))
    events.start()

    FakeSocket.instances[0]!.emit('unexpected-response', {}, { statusCode: 401 })

    expect(failures).toHaveLength(1)
    expect(failures[0]!.name).toBe('ProtectAuthError')
    events.stop()
  })

  it('resyncs each channel independently', async () => {
    const events = makeEvents()
    const resyncs: unknown[] = []
    events.on('resyncRequired', channel => resyncs.push(channel))
    events.start()
    const [devices, eventStream] = [FakeSocket.instances[0]!, FakeSocket.instances[1]!]
    devices.open()
    eventStream.open()

    devices.fail()
    await vi.advanceTimersByTimeAsync(2000)
    FakeSocket.instances.at(-1)!.open()
    expect(resyncs).toEqual(['devices'])

    // The events channel has never dropped, so it must not have resynced. When
    // it does drop, it resyncs on its own without a second 'devices'.
    eventStream.fail()
    await vi.advanceTimersByTimeAsync(2000)
    FakeSocket.instances.at(-1)!.open()
    expect(resyncs).toEqual(['devices', 'events'])
    events.stop()
  })

  it('terminates and reconnects a socket that stops answering pings', async () => {
    const events = makeEvents()
    events.start()
    const devices = FakeSocket.instances[0]!
    devices.autoPong = false
    devices.open()
    const countAtOpen = FakeSocket.instances.length

    // First interval sends a ping, the second finds no pong and gives up.
    await vi.advanceTimersByTimeAsync(70_000)

    expect(devices.pings).toBeGreaterThan(0)
    expect(devices.terminated).toBe(true) // terminate(), not close()
    expect(FakeSocket.instances.length).toBeGreaterThan(countAtOpen)
    events.stop()
  })

  it('leaves an idle but healthy socket alone', async () => {
    const events = makeEvents()
    const resyncs: unknown[] = []
    events.on('resyncRequired', channel => resyncs.push(channel))
    events.start()
    for (const socket of FakeSocket.instances)
      socket.open()
    const countAtOpen = FakeSocket.instances.length

    // Ten minutes of complete silence — normal for a quiet house.
    await vi.advanceTimersByTimeAsync(600_000)

    expect(FakeSocket.instances[0]!.pings).toBeGreaterThan(5)
    expect(FakeSocket.instances[0]!.terminated).toBe(false)
    expect(FakeSocket.instances).toHaveLength(countAtOpen)
    expect(resyncs).toEqual([])
    events.stop()
  })

  it('does not let a throwing listener escape into the socket', () => {
    const events = makeEvents()
    events.on('deviceUpdate', () => {
      throw new Error('zod said no')
    })
    events.start()
    const devices = FakeSocket.instances[0]!
    devices.open()

    expect(() => devices.send(JSON.stringify({ type: 'update' }))).not.toThrow()
    expect(log.warn).toHaveBeenCalled()
    expect(devices.readyState).toBe(1)
    events.stop()
  })

  it('leaves live subscriptions untouched on a repeated start()', async () => {
    const events = makeEvents()
    const seen: unknown[] = []
    const resyncs: unknown[] = []
    events.on('deviceUpdate', payload => seen.push(payload))
    events.on('resyncRequired', channel => resyncs.push(channel))
    events.start()
    const devices = FakeSocket.instances[0]!
    devices.open()
    FakeSocket.instances[1]!.open()

    // The platform calls start() again on its retry paths. Replacing a healthy
    // socket would drop it and cost a full spurious discovery pass.
    events.start()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(FakeSocket.instances).toHaveLength(2)
    expect(devices.readyState).toBe(1)
    expect(resyncs).toEqual([])

    devices.send(JSON.stringify({ id: 'cam1' }))
    expect(seen).toEqual([{ id: 'cam1' }]) // emitted once, not twice
    events.stop()
  })

  it('restarts only the channels that are actually down', async () => {
    const events = makeEvents()
    events.start()
    const [devices, eventStream] = [FakeSocket.instances[0]!, FakeSocket.instances[1]!]
    devices.open()
    eventStream.open()
    eventStream.fail() // this one is down, with a reconnect pending

    events.start()
    // The redial must cancel the pending reconnect timer, not race it.
    await vi.advanceTimersByTimeAsync(120_000)

    expect(FakeSocket.instances).toHaveLength(3) // devices untouched, events redialled
    expect(devices.readyState).toBe(1)
    events.stop()
  })

  it('redials a channel whose socket is closing', () => {
    const events = makeEvents()
    events.start()
    const devices = FakeSocket.instances[0]!
    devices.open()
    devices.readyState = 2 // CLOSING — going away, so it must not be left alone

    events.start()

    expect(FakeSocket.instances).toHaveLength(3)
    expect(FakeSocket.instances.at(-1)!.url).toContain('/subscribe/devices')
    events.stop()
  })

  it('does not crash when stop() closes a socket that never connected', () => {
    const events = makeEvents()
    events.start()

    // Every socket is still CONNECTING — the normal shape of a shutdown while
    // the console is unreachable, since the dial hangs on the SYN.
    expect(FakeSocket.instances[0]!.readyState).toBe(0)
    expect(() => events.stop()).not.toThrow()
  })

  it('does not crash when a reconnect replaces a socket that never connected', async () => {
    const events = makeEvents()
    events.start()
    FakeSocket.instances[0]!.fail()
    await vi.advanceTimersByTimeAsync(2000)

    // The redial is CONNECTING; a second failure tears it down mid-handshake.
    const pending = FakeSocket.instances.at(-1)!
    expect(pending.readyState).toBe(0)
    expect(() => events.stop()).not.toThrow()
  })

  it('survives a stop() then start() without leaking the old sockets', async () => {
    const events = makeEvents()
    events.start()
    const stale = FakeSocket.instances[0]!
    stale.open()
    events.stop()
    events.start()

    const countAtRestart = FakeSocket.instances.length
    stale.fail() // a close delivered late, after the socket was discarded
    await vi.advanceTimersByTimeAsync(120_000)

    expect(FakeSocket.instances).toHaveLength(countAtRestart)
    events.stop()
  })
})
