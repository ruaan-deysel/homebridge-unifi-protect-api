import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { TALKBACK_BUFFER_LIMIT, TalkbackRelay } from '../src/protect/talkback.js'

function harness(open: () => Promise<number | undefined>) {
  const socket = new EventEmitter() as EventEmitter & { close: () => void }
  socket.close = () => {}
  const forwarded: Array<{ packet: Buffer, port: number }> = []
  const warnings: string[] = []
  const relay = new TalkbackRelay({
    socket: socket as never,
    open,
    forward: (packet, port) => forwarded.push({ packet, port }),
    log: { warn: (m: string) => warnings.push(m) },
  })
  return { socket, forwarded, warnings, relay }
}

describe('talkbackRelay', () => {
  it('does not open until a packet arrives', async () => {
    let calls = 0
    harness(async () => {
      calls++
      return 5000
    })
    await Promise.resolve()
    expect(calls).toBe(0)
  })

  it('opens exactly once for a burst', async () => {
    let calls = 0
    const h = harness(async () => {
      calls++
      return 5000
    })
    for (let i = 0; i < 5; i++) h.socket.emit('message', Buffer.from([i]))
    await new Promise(r => setImmediate(r))
    expect(calls).toBe(1)
  })

  it('forwards packets buffered during open, in order', async () => {
    let release: (p: number) => void = () => {}
    const h = harness(() => new Promise<number>((r) => {
      release = r
    }))
    h.socket.emit('message', Buffer.from([1]))
    h.socket.emit('message', Buffer.from([2]))
    release(5000)
    await new Promise(r => setImmediate(r))
    expect(h.forwarded.map(f => f.packet[0])).toEqual([1, 2])
    expect(h.forwarded.every(f => f.port === 5000)).toBe(true)
  })

  it('drops the oldest past the buffer cap', async () => {
    let release: (p: number) => void = () => {}
    const h = harness(() => new Promise<number>((r) => {
      release = r
    }))
    for (let i = 0; i < TALKBACK_BUFFER_LIMIT + 10; i++) h.socket.emit('message', Buffer.from([i & 0xFF]))
    release(5000)
    await new Promise(r => setImmediate(r))
    expect(h.forwarded).toHaveLength(TALKBACK_BUFFER_LIMIT)
    expect(h.forwarded[0]?.packet[0]).toBe(10)
  })

  it('forwards nothing when open yields no port', async () => {
    const h = harness(async () => undefined)
    h.socket.emit('message', Buffer.from([1]))
    await new Promise(r => setImmediate(r))
    expect(h.forwarded).toEqual([])
  })

  it('reports a rejected open as a message, never the error object', async () => {
    const h = harness(async () => {
      throw new Error('boom')
    })
    h.socket.emit('message', Buffer.from([1]))
    await new Promise(r => setImmediate(r))
    expect(h.warnings.join(' ')).toContain('boom')
    expect(h.forwarded).toEqual([])
  })

  it('forwards nothing after close', async () => {
    const h = harness(async () => 5000)
    h.relay.close()
    h.socket.emit('message', Buffer.from([1]))
    await new Promise(r => setImmediate(r))
    expect(h.forwarded).toEqual([])
  })

  it('stops forwarding once closed, even with a session already open', async () => {
    const h = harness(async () => 5000)
    h.socket.emit('message', Buffer.from([1]))
    await new Promise(r => setImmediate(r))
    expect(h.forwarded).toHaveLength(1)
    h.relay.close()
    h.socket.emit('message', Buffer.from([2]))
    await new Promise(r => setImmediate(r))
    expect(h.forwarded).toHaveLength(1)
  })
})
