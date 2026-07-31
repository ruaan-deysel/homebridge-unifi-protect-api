import type { IncomingMessage } from 'node:http'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { API_BASE_PATH } from '../settings.js'
import { ProtectAuthError } from './errors.js'

/**
 * The four log methods this module needs. Declared here rather than imported so
 * `src/protect/**` stays free of Homebridge types; structurally compatible with
 * Homebridge's `Logging`.
 */
export interface ProtectLogger {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
  debug: (message: string) => void
}

export interface ProtectEventsOptions {
  host: string
  apiKey: string
  log: ProtectLogger
  /** Injected in tests. Defaults to the `ws` package. */
  socketFactory?: (url: string, options: unknown) => WebSocket
  maxBackoffMs?: number
}

export type ProtectEventChannel = 'devices' | 'events'

/**
 * Keeps both Protect subscriptions alive. There is no polling anywhere in this
 * plugin — every state change arrives here.
 */
export class ProtectEvents extends EventEmitter {
  private readonly host: string
  private readonly apiKey: string
  private readonly log: ProtectLogger
  private readonly makeSocket: (url: string, options: unknown) => WebSocket
  private readonly maxBackoffMs: number
  private readonly sockets = new Map<ProtectEventChannel, WebSocket>()
  private readonly timers = new Map<ProtectEventChannel, ReturnType<typeof setTimeout>>()
  private readonly attempts = new Map<ProtectEventChannel, number>()
  private readonly connectedBefore = new Set<ProtectEventChannel>()
  private stopped = false
  private authFailed = false

  constructor(options: ProtectEventsOptions) {
    super()
    this.host = options.host
    this.apiKey = options.apiKey
    this.log = options.log
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000
    // `ws`, NOT node's global WebSocket. The global is the WHATWG browser API:
    // it has no `headers` option, so it cannot send X-API-KEY, and no way to
    // skip verification of the console's self-signed certificate. Verified
    // against real hardware — the global fails with a non-101 status.
    this.makeSocket = options.socketFactory
      ?? ((url, opts) => new WebSocket(url, opts as never))
  }

  start(): void {
    this.stopped = false
    this.authFailed = false
    this.connect('devices')
    this.connect('events')
  }

  stop(): void {
    this.stopped = true
    for (const timer of this.timers.values())
      clearTimeout(timer)
    this.timers.clear()
    for (const socket of this.sockets.values())
      socket.close()
    this.sockets.clear()
  }

  private connect(channel: ProtectEventChannel): void {
    if (this.stopped || this.authFailed)
      return

    const url = `wss://${this.host}${API_BASE_PATH}/v1/subscribe/${channel}`
    const socket = this.makeSocket(url, {
      headers: { 'X-API-KEY': this.apiKey },
      rejectUnauthorized: false,
    })
    this.sockets.set(channel, socket)

    socket.onopen = () => {
      this.attempts.set(channel, 0)
      this.log.debug(`Protect ${channel} subscription connected.`)
      if (this.connectedBefore.has(channel)) {
        // Frames missed while the socket was down are never replayed, so the
        // only correct recovery is a full REST resync.
        this.emit('resyncRequired', channel)
      }
      this.connectedBefore.add(channel)
    }

    socket.onmessage = (event: { data: unknown }) => {
      let payload: unknown
      try {
        payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      }
      catch {
        this.log.debug(`Discarding unparseable frame on the ${channel} subscription.`)
        return
      }
      this.emit(channel === 'devices' ? 'deviceUpdate' : 'protectEvent', payload)
    }

    socket.onerror = () => {
      this.log.debug(`Protect ${channel} subscription errored.`)
    }

    socket.onclose = () => {
      this.sockets.delete(channel)
      this.scheduleReconnect(channel)
    }

    // `ws` reports a non-101 handshake here, with the real status code. This is
    // the only place 401 is distinguishable from a transient network failure —
    // an `error` alone cannot tell them apart.
    socket.on?.('unexpected-response', (_request: unknown, response: IncomingMessage) => {
      if (response.statusCode !== 401 && response.statusCode !== 403) {
        this.log.debug(`Protect ${channel} subscription refused with status ${response.statusCode}.`)
        return
      }
      this.authFailed = true
      const error = new ProtectAuthError('The Protect API key was rejected by the console.')
      this.log.error(`${error.message} Not retrying the ${channel} subscription until the plugin restarts.`)
      for (const timer of this.timers.values())
        clearTimeout(timer)
      this.timers.clear()
    })
  }

  private scheduleReconnect(channel: ProtectEventChannel): void {
    if (this.stopped || this.authFailed)
      return
    const attempt = (this.attempts.get(channel) ?? 0) + 1
    this.attempts.set(channel, attempt)
    const delay = Math.min(1000 * 2 ** (attempt - 1), this.maxBackoffMs)
    this.log.debug(`Protect ${channel} subscription dropped, reconnecting in ${delay}ms.`)
    this.timers.set(channel, setTimeout(() => this.connect(channel), delay))
  }
}
