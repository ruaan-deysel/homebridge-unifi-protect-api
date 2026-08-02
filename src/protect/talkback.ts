import type { Buffer } from 'node:buffer'
import type { Socket } from 'node:dgram'
import { errorMessage } from './errors.js'

/**
 * Datagrams held while the console session opens. The POST measured 120-195 ms
 * against the reference console, which at Opus packet rates is far below this;
 * the cap exists so an open that never completes cannot grow memory without
 * limit. Past it the OLDEST are dropped — losing the start of a sentence beats
 * holding audio forever.
 */
export const TALKBACK_BUFFER_LIMIT = 64

export interface TalkbackRelayOptions {
  /** The already-bound socket HomeKit sends return audio to. */
  socket: Socket
  /**
   * Creates the console session and starts the encoder, resolving to the
   * loopback port ffmpeg listens on — or undefined if it could not start.
   * Called at most once.
   */
  open: () => Promise<number | undefined>
  forward: (packet: Buffer, port: number) => void
  log: { warn: (message: string) => void }
}

/**
 * Sits between HomeKit and the talkback encoder so the session can open LAZILY.
 * ffmpeg cannot do this itself: it must bind the port, and it needs its output
 * URL at spawn time — so nothing would be left to notice the first packet.
 *
 * This never decrypts. It forwards SRTP verbatim; ffmpeg holds the key.
 */
export class TalkbackRelay {
  private buffered: Buffer[] = []
  private target?: number
  private opening = false
  private closed = false

  constructor(private readonly options: TalkbackRelayOptions) {
    options.socket.on('message', (packet: Buffer) => this.onPacket(packet))
  }

  private onPacket(packet: Buffer): void {
    if (this.closed)
      return
    if (this.target !== undefined) {
      this.options.forward(packet, this.target)
      return
    }
    this.buffered.push(packet)
    if (this.buffered.length > TALKBACK_BUFFER_LIMIT)
      this.buffered.shift()
    if (this.opening)
      return
    this.opening = true
    void this.begin()
  }

  private async begin(): Promise<void> {
    let port: number | undefined
    try {
      port = await this.options.open()
    }
    catch (error) {
      // errorMessage, never the error itself: the client's error carries a
      // request context, which is the path that has leaked the API key before.
      this.options.log.warn(`Could not start talkback: ${errorMessage(error)}`)
    }
    if (port === undefined || this.closed) {
      this.buffered = []
      return
    }
    this.target = port
    for (const packet of this.buffered)
      this.options.forward(packet, port)
    this.buffered = []
  }

  /** Idempotent. After this nothing is forwarded and nothing is held. */
  close(): void {
    this.closed = true
    this.buffered = []
  }
}
