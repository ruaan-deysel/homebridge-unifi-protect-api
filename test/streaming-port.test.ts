import type { PrepareStreamRequest } from 'homebridge'
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { StreamingDelegate } from '../src/accessories/streaming.js'

/**
 * A dgram socket whose bind fails. Its own file because `vi.mock` replaces the
 * module for the whole file, and every other streaming test wants real sockets.
 *
 * `bind(0, cb)` never calls back on failure — it emits `error` instead — so a
 * `new Promise(resolve => socket.bind(0, resolve))` simply never settles:
 * prepareStream hangs forever, HomeKit is left waiting, and the reserved slot
 * hangs with it. An unhandled dgram `error` also throws out of the event loop.
 */
vi.mock('node:dgram', () => ({
  createSocket: () => {
    const socket = Object.assign(new EventEmitter(), {
      bind: () => {
        setImmediate(() => socket.emit('error', new Error('bind EADDRINUSE')))
      },
      address: () => ({ port: 0 }),
      close: () => {
        // Real dgram throws ERR_SOCKET_DGRAM_NOT_RUNNING for a socket that
        // never bound, and the cleanup must not mask the bind failure.
        throw new Error('Not running')
      },
    })
    return socket
  },
}))

function prepareRequest(): PrepareStreamRequest {
  return {
    sessionID: 'session-1',
    sourceAddress: '192.0.2.20',
    targetAddress: '192.0.2.9',
    addressVersion: 'ipv4',
    video: { port: 5000, srtpCryptoSuite: 0, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) },
    audio: { port: 5002, srtpCryptoSuite: 0, srtp_key: Buffer.alloc(16, 3), srtp_salt: Buffer.alloc(14, 4) },
  }
}

describe('prepareStream when a port cannot be reserved', () => {
  it('answers homekit with an error instead of never answering at all', async () => {
    const delegate = new StreamingDelegate({
      deviceId: 'cam1',
      label: 'Driveway',
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      client: {} as never,
      urls: {} as never,
      caps: { path: '/usr/bin/ffmpeg', encoder: 'libx264' },
      settings: () => ({ quality: 'auto', audio: false, talkback: false }),
    })

    // A 1s race, not an unbounded await: the bug under test is a promise that
    // NEVER settles, and a plain `await` on it would hang the whole suite
    // rather than fail this one test.
    const outcome = await Promise.race([
      new Promise<unknown>(resolve => delegate.prepareStream(prepareRequest(), resolve)),
      // Arg passed to setTimeout rather than closed over: e18e/prefer-timer-args.
      new Promise(resolve => setTimeout(resolve, 1000, 'never answered')),
    ])

    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toContain('EADDRINUSE')
  })
})
