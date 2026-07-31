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
    this.readyState = 3
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
})
