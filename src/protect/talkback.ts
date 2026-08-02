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
/**
 * True only for something that looks like an RTP media packet.
 *
 * HAP muxes SRTCP receiver reports onto the SAME port the return audio arrives
 * on, and it sends them on every live view whether or not anybody ever speaks.
 * Unfiltered, the first receiver report opens the console session and spawns
 * the encoder — the doorbell speaker arms every time somebody looks, which is
 * the entire thing the lazy design exists to avoid. Forwarded, they land in
 * ffmpeg's SRTP input and fail authentication, because SRTCP derives its keys
 * differently: a steady stream of decrypt errors for packets that were never
 * media.
 *
 * RFC 5761 §4: with RTP and RTCP muxed, the second byte's payload-type field
 * (the marker bit masked off) is 72-76 for RTCP. Byte 0's top two bits are the
 * RTP version, which is 2 for both, and 12 bytes is the fixed RTP header.
 */
export function isRtpMedia(packet: Buffer): boolean {
  if (packet.length < 12 || (packet[0]! & 0xC0) !== 0x80)
    return false
  const payloadType = packet[1]! & 0x7F
  return payloadType < 72 || payloadType > 76
}

export class TalkbackRelay {
  private buffered: Buffer[] = []
  private target?: number
  private opening = false
  private closed = false

  constructor(private readonly options: TalkbackRelayOptions) {
    options.socket.on('message', (packet: Buffer) => this.onPacket(packet))
  }

  private onPacket(packet: Buffer): void {
    // Before the buffering AND before the forward: an RTCP packet must neither
    // trigger the open nor reach ffmpeg. See isRtpMedia.
    if (this.closed || !isRtpMedia(packet))
      return
    if (this.target !== undefined) {
      this.options.forward(packet, this.target)
      return
    }
    this.buffered.push(packet)
    if (this.buffered.length > TALKBACK_BUFFER_LIMIT)
      this.buffered.shift()
    // `opening` is latched for the life of the session and never cleared, so a
    // FAILED open is never retried: the console answers a speaker-less camera
    // with a 503, and retrying per datagram would be a POST every 20 ms for as
    // long as somebody holds the talk button. Deliberate — the viewer's remedy
    // is to close the live view and reopen it, which builds a new relay.
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
  /** srtp_key ‖ srtp_salt as HomeKit sent them. */
  key: Buffer
  /** True when the relay's socket is udp6, so the loopback family must match. */
  ipv6?: boolean
}

/**
 * RFC 7587 §7: the `a=rtpmap` clock rate for Opus MUST be 48000 and the channel
 * count MUST be 2, whatever rate the stream is actually encoded at — "the RTP
 * timestamp is incremented with a 48000 Hz clock rate for all modes of Opus and
 * all sampling rates".
 *
 * NOT cosmetic. ffmpeg's SDP parser sets the stream time_base to 1/clock_rate,
 * so declaring HomeKit's negotiated 16000 makes every 20 ms frame (960 ticks of
 * a 48 kHz clock) read as 60 ms of media. Every PTS is stretched, and the
 * re-emitted RTP carries that stretch into the doorbell's jitter buffer. The
 * decoder outputs 48 kHz regardless, so the symptom is timing, never pitch.
 */
const OPUS_CLOCK_RATE = 48000

/**
 * Raw RTP carries no format metadata, so ffmpeg cannot decode an SRTP stream
 * from a URL alone — it needs an SDP describing the payload and the key. This
 * is fed on stdin rather than written to a file: it contains the session key,
 * and a temp file would put that secret on disk.
 *
 * `RTP/SAVP` and the `a=crypto` line are what make it SRTP rather than RTP.
 *
 * The connection address follows the RELAY's socket family: on an IPv6 session
 * the socket is udp6, and `dgram.send` to an IPv4 literal from one fails — so a
 * v4 loopback here would mean an encoder that spawns, idles and never receives
 * a single datagram.
 */
export function talkbackSdp(options: TalkbackSdpOptions): string {
  const loopback = options.ipv6 ? 'IP6 ::1' : 'IP4 127.0.0.1'
  return [
    'v=0',
    `o=- 0 0 IN ${loopback}`,
    's=Talkback',
    `c=IN ${loopback}`,
    't=0 0',
    `m=audio ${options.listenPort} RTP/SAVP ${options.payloadType}`,
    `a=rtpmap:${options.payloadType} opus/${OPUS_CLOCK_RATE}/2`,
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
  // The console supplies this url and it becomes an ffmpeg OUTPUT. `-f rtp`
  // does not constrain the protocol and `-protocol_whitelist` is input-side
  // only, so a `file://` or `http://` value from a spoofed or compromised
  // console would be a WRITE, not a stream. The generated schema says only
  // `z.url()`, and it is generated — the guard belongs here, at the one place
  // the value turns into an argument. The message never quotes the url.
  if (!/^rtp:\/\//i.test(options.destination))
    throw new Error('The console answered with a talkback destination that is not an rtp:// url; refusing to run it.')
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
