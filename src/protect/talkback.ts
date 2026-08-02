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

export interface TalkbackSdpOptions {
  /** The loopback port ffmpeg listens on — the relay forwards here. */
  listenPort: number
  /** HomeKit's chosen payload type, from the start request. */
  payloadType: number
  /** HomeKit's chosen sample rate in Hz. */
  sampleRate: number
  /** srtp_key ‖ srtp_salt as HomeKit sent them. */
  key: Buffer
}

/**
 * Raw RTP carries no format metadata, so ffmpeg cannot decode an SRTP stream
 * from a URL alone — it needs an SDP describing the payload and the key. This
 * is fed on stdin rather than written to a file: it contains the session key,
 * and a temp file would put that secret on disk.
 *
 * `RTP/SAVP` and the `a=crypto` line are what make it SRTP rather than RTP.
 * Opus is always declared with two channels in an SDP even when the stream is
 * mono; that is the RFC 7587 convention, not a mistake.
 */
export function talkbackSdp(options: TalkbackSdpOptions): string {
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=Talkback',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    `m=audio ${options.listenPort} RTP/SAVP ${options.payloadType}`,
    `a=rtpmap:${options.payloadType} opus/${options.sampleRate}/2`,
    `a=fmtp:${options.payloadType} minptime=10;useinbandfec=1`,
    `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${options.key.toString('base64')}`,
    '',
  ].join('\r\n')
}

export interface TalkbackArgsOptions {
  /** The console's talkback URL, e.g. rtp://192.168.10.9:7004. */
  destination: string
  /** The rate the CONSOLE declared it wants (24000 on the reference doorbell). */
  sampleRate: number
}

/**
 * Decodes HomeKit's SRTP and re-emits Opus RTP at whatever the console asked
 * for. Output options precede `-f rtp` and the destination: ffmpeg applies them
 * to the output that FOLLOWS, and anything after the URL is silently ignored —
 * a defect this repo has already shipped once with `-r`.
 */
export function buildTalkbackArgs(options: TalkbackArgsOptions): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    // ffmpeg refuses protocols an SDP refers to unless they are listed.
    '-protocol_whitelist',
    'pipe,udp,rtp,srtp',
    '-f',
    'sdp',
    '-i',
    'pipe:0',
    '-c:a',
    'libopus',
    '-ar',
    String(options.sampleRate),
    '-ac',
    '1',
    '-application',
    'voip',
    '-f',
    'rtp',
    options.destination,
  ]
}
