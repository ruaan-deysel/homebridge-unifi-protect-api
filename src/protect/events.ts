import type { IncomingMessage } from 'node:http'
import type { ProtectLogger } from './client.js'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { API_BASE_PATH } from '../settings.js'
import { pinnedTlsOptions } from './cert.js'
import { ProtectAuthError } from './errors.js'

export type ProtectEventChannel = 'devices' | 'events'

/**
 * Payloads are deliberately `unknown` — frames arrive straight off the wire and
 * are only JSON-parsed here. Consumers must validate with the zod schemas
 * before touching any field.
 */
export interface ProtectEventsMap {
  deviceUpdate: [payload: unknown]
  protectEvent: [payload: unknown]
  resyncRequired: [channel: ProtectEventChannel]
  authFailed: [error: ProtectAuthError]
}

export interface ProtectEventsOptions {
  host: string
  apiKey: string
  log: ProtectLogger
  /** Injected in tests. Defaults to the `ws` package. */
  socketFactory?: (url: string, options: unknown) => WebSocket
  maxBackoffMs?: number
  /** PEM of the trusted console certificate. See `consoleCert` on the class. */
  consoleCert?: string
}

interface ChannelState {
  socket?: WebSocket
  reconnectTimer?: ReturnType<typeof setTimeout>
  pingTimer?: ReturnType<typeof setInterval>
  stableTimer?: ReturnType<typeof setTimeout>
  attempts: number
  connectedBefore: boolean
  alive: boolean
}

const CHANNELS: ProtectEventChannel[] = ['devices', 'events']

/** How often to prove the socket is still carrying traffic. `ws` never pings on its own. */
const PING_INTERVAL_MS = 30_000

/** Time connected before a connection counts as stable and the backoff resets. */
const STABLE_AFTER_MS = 30_000

/**
 * Bounds the upgrade — `ws` waits forever by default; see the note in `connect`.
 *
 * Measured, not assumed: over `wss://` the effective wait is **double** this,
 * because the timeout is armed once for the TCP connect and again once the
 * TLSSocket is wrapped (`ws` 5s → errored at 10.0s, 15s → 30.0s; plain `ws://`
 * 5s → 5.0s). So this is a ~30s real bound, which is the right order for a
 * console that is rebooting rather than dead.
 */
const HANDSHAKE_TIMEOUT_MS = 15_000

/**
 * Keeps both Protect subscriptions alive. There is no polling anywhere in this
 * plugin — every state change arrives here.
 */
export class ProtectEvents extends EventEmitter<ProtectEventsMap> {
  private readonly host: string
  private readonly apiKey: string
  private readonly log: ProtectLogger
  private readonly makeSocket: (url: string, options: unknown) => WebSocket
  private readonly maxBackoffMs: number
  private readonly states = new Map<ProtectEventChannel, ChannelState>()
  private stopped = false
  private authFailed = false
  /**
   * Trust anchor for the WebSocket upgrades. The upgrade request carries the
   * same `X-API-KEY` header the REST calls do, so this path is pinned exactly
   * like the REST one. Writable for the same trust-on-first-use reason as on
   * `ProtectClient`; until it is set, `connect` refuses to dial.
   */
  consoleCert?: string

  constructor(options: ProtectEventsOptions) {
    super()
    this.host = options.host
    this.apiKey = options.apiKey
    this.log = options.log
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000
    this.consoleCert = options.consoleCert
    // `ws`, NOT node's global WebSocket. The global is the WHATWG browser API:
    // it has no `headers` option, so it cannot send X-API-KEY, and no way to
    // supply the console's certificate as a trust anchor. Verified against real
    // hardware — the global fails with a non-101 status.
    this.makeSocket = options.socketFactory
      ?? ((url, opts) => new WebSocket(url, opts as never))
  }

  start(): void {
    this.stopped = false
    this.authFailed = false
    for (const channel of CHANNELS) {
      // Leave a subscription that is already live alone. The platform calls
      // `start()` again on its retry paths, and tearing down a healthy socket
      // just to redial it emits a spurious `resyncRequired` — a full, pointless
      // REST discovery pass on every startup.
      const socket = this.stateOf(channel).socket
      if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN))
        continue
      this.connect(channel)
    }
  }

  stop(): void {
    this.stopped = true
    for (const channel of CHANNELS)
      this.teardown(channel)
    // `connectedBefore` is deliberately NOT cleared: after a stop the plugin's
    // view of the console is stale, so the next connect *should* resync.
  }

  private stateOf(channel: ProtectEventChannel): ChannelState {
    let state = this.states.get(channel)
    if (!state) {
      state = { attempts: 0, connectedBefore: false, alive: false }
      this.states.set(channel, state)
    }
    return state
  }

  /** Cancels every timer for a channel and detaches its socket so it cannot reconnect. */
  private teardown(channel: ProtectEventChannel): void {
    const state = this.stateOf(channel)
    clearTimeout(state.reconnectTimer)
    clearInterval(state.pingTimer)
    clearTimeout(state.stableTimer)
    state.reconnectTimer = undefined
    state.pingTimer = undefined
    state.stableTimer = undefined

    const socket = state.socket
    if (!socket)
      return
    state.socket = undefined
    // Detach first — otherwise this socket's `close` schedules a reconnect for a
    // connection we have already replaced or shut down.
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    socket.removeAllListeners()
    // `close()` on a CONNECTING socket routes to ws's `abortHandshake`, which
    // emits 'error' on the next tick. With no listener left attached node
    // rethrows it as an uncaught exception and takes the process down. A
    // shutdown while the console is unreachable hits this every time — the dial
    // hangs on the SYN, so the socket is CONNECTING for nearly all of its life.
    socket.on('error', () => {})
    socket.close()
  }

  private connect(channel: ProtectEventChannel): void {
    if (this.stopped || this.authFailed)
      return

    // Fail closed, exactly as the REST transport does: the upgrade request
    // carries the API key, so it is not dialled at all until the console's
    // certificate is trusted. No reconnect is scheduled — nothing about a
    // retry would supply the missing trust anchor.
    if (!this.consoleCert) {
      this.log.error(`Not connecting the Protect ${channel} subscription: the console's certificate has not been trusted yet.`)
      return
    }

    // Makes `start()` idempotent and stops a duplicate `close` doubling the
    // reconnect chain.
    this.teardown(channel)
    const state = this.stateOf(channel)

    const url = `wss://${this.host}${API_BASE_PATH}/v1/subscribe/${channel}`
    const socket = this.makeSocket(url, {
      headers: { 'X-API-KEY': this.apiKey },
      // Pinned to the console's own certificate — the handshake fails before the
      // upgrade request (and the header above) is written. See pinnedTlsOptions.
      ...pinnedTlsOptions(this.consoleCert),
      // `ws` has no default handshake timeout. A console that accepts the TCP
      // connection and then never answers the upgrade — a half-dead UDM, or a
      // stalled reverse proxy — leaves the socket CONNECTING forever: the
      // watchdog is only armed in `onopen`, `scheduleReconnect` only fires from
      // `onclose`, and `start()` skips a CONNECTING channel. Nothing else
      // recovers it. Bounding the wait turns the wedge into a normal
      // error -> close -> backoff cycle.
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    })
    state.socket = socket

    socket.onopen = () => {
      this.log.debug(`Protect ${channel} subscription connected.`)
      // The backoff resets only once the connection has *held*. A console that
      // accepts the upgrade then drops it a second later would otherwise be
      // hammered at the floor delay forever.
      state.stableTimer = setTimeout(() => {
        state.attempts = 0
      }, STABLE_AFTER_MS)
      this.startWatchdog(channel, socket, state)

      if (state.connectedBefore) {
        // Frames missed while the socket was down are never replayed, so the
        // only correct recovery is a full REST resync.
        this.emit('resyncRequired', channel)
      }
      state.connectedBefore = true
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
      // The payload is unvalidated. A consumer that throws — a failed zod parse,
      // most likely, after a firmware change alters a shape — must not become an
      // uncaught exception inside `ws` and take Homebridge down with it.
      try {
        this.emit(channel === 'devices' ? 'deviceUpdate' : 'protectEvent', payload)
      }
      catch (error) {
        this.log.warn(`A ${channel} subscription listener threw: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    socket.onerror = () => {
      this.log.debug(`Protect ${channel} subscription errored.`)
    }

    socket.onclose = () => {
      clearInterval(state.pingTimer)
      clearTimeout(state.stableTimer)
      state.pingTimer = undefined
      state.stableTimer = undefined
      state.socket = undefined
      this.scheduleReconnect(channel)
    }

    // `ws` reports a non-101 handshake here, with the real status code. This is
    // the only place 401 is distinguishable from a transient network failure —
    // an `error` alone cannot tell them apart.
    socket.on('unexpected-response', (_request: unknown, response: IncomingMessage) => {
      if (response.statusCode !== 401 && response.statusCode !== 403) {
        this.log.debug(`Protect ${channel} subscription refused with status ${response.statusCode}.`)
        return
      }
      this.authFailed = true
      const error = new ProtectAuthError('The Protect API key was rejected by the console.')
      this.log.error(`${error.message} Not retrying the subscriptions until the plugin restarts.`)
      for (const other of CHANNELS)
        clearTimeout(this.stateOf(other).reconnectTimer)
      this.emit('authFailed', error)
    })
  }

  /**
   * `ws` answers pings but never sends them (`autoPong: true`, and there is no
   * `setInterval` anywhere in the library). Without this, a NAT or firewall that
   * silently drops the flow leaves `readyState` OPEN with no `close` and no
   * `error` — the plugin would deliver nothing, forever, with no log output, and
   * since both endpoints are legitimately silent when idle that is
   * indistinguishable from a healthy, quiet house.
   */
  private startWatchdog(channel: ProtectEventChannel, socket: WebSocket, state: ChannelState): void {
    state.alive = true
    socket.on('pong', () => {
      state.alive = true
    })
    state.pingTimer = setInterval(() => {
      if (!state.alive) {
        this.log.warn(`Protect ${channel} subscription stopped responding, forcing a reconnect.`)
        // `terminate`, not `close` — a half-open peer never completes the
        // closing handshake, so `close` would hang instead of reconnecting.
        socket.terminate()
        return
      }
      state.alive = false
      socket.ping()
    }, PING_INTERVAL_MS)
  }

  private scheduleReconnect(channel: ProtectEventChannel): void {
    if (this.stopped || this.authFailed)
      return
    const state = this.stateOf(channel)
    state.attempts += 1
    const delay = Math.min(1000 * 2 ** (state.attempts - 1), this.maxBackoffMs)
    this.log.debug(`Protect ${channel} subscription dropped, reconnecting in ${delay}ms.`)
    clearTimeout(state.reconnectTimer)
    state.reconnectTimer = setTimeout(() => this.connect(channel), delay)
  }
}
