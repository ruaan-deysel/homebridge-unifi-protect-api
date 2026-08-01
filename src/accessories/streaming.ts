import type {
  CameraStreamingDelegate,
  PrepareStreamCallback,
  PrepareStreamRequest,
  SnapshotRequest,
  SnapshotRequestCallback,
  StartStreamRequest,
  StreamingRequest,
  StreamRequestCallback,
} from 'homebridge'
import type { ProtectClient } from '../protect/client.js'
import type { FfmpegCapabilities, RunFfmpeg, SpawnFn } from '../protect/ffmpeg.js'
import type { StreamUrls } from '../protect/stream.js'
import type { QualityPreference } from './quality.js'
import { Buffer } from 'node:buffer'
import { createSocket } from 'node:dgram'
import { errorMessage } from '../protect/errors.js'
import { FfmpegProcess, runFfmpeg } from '../protect/ffmpeg.js'
import { selectQuality } from './quality.js'

/**
 * Measured on the reference host (i7-8700K, UHD 630) on 2026-08-01: 20s of
 * 2688x1512 HEVC to H.264 costs 1.79s CPU via VAAPI and 49.1s via libx264.
 * A single flat cap would be far too low for hardware and dangerously high for
 * software, where three concurrent streams would saturate a 12-thread host.
 */
export function defaultMaxStreams(caps: FfmpegCapabilities): number {
  return caps.encoder === 'libx264' ? 2 : 6
}

/** One RTP destination HomeKit prepared: its port, its SSRC and its own SRTP key. */
export interface RtpTarget {
  port: number
  ssrc: number
  /** srtp_key ‖ srtp_salt, as HomeKit sent them. */
  key: Buffer
  /** HomeKit chooses the payload type per stream; it is not ours to assume. */
  payloadType: number
  /** Our own RTCP port, so HomeKit's receiver reports reach this process. */
  localPort?: number
}

export interface AudioStreamArgs extends RtpTarget {
  /** kHz, straight from HomeKit's AudioInfo (8, 16 or 24). */
  sampleRate: number
  /** kbit/s. */
  bitrate: number
}

export interface StreamArgs {
  url: string
  bitrate: number
  address: string
  video: RtpTarget
  /** Absent means video-only: either the camera opted out or AAC-ELD is unavailable. */
  audio?: AudioStreamArgs
}

/** HomeKit only ever accepts AAC-ELD, and only libfdk_aac encodes it. */
export const AAC_ELD_ENCODER = 'libfdk_aac'

const SRTP_SUITE = 'AES_CM_128_HMAC_SHA1_80'

function destination(address: string, target: RtpTarget, packetSize: number): string {
  const host = address.includes(':') ? `[${address}]` : address
  const local = target.localPort === undefined ? '' : `&localrtcpport=${target.localPort}`
  return `srtp://${host}:${target.port}?rtcpport=${target.port}${local}&pkt_size=${packetSize}`
}

export function buildFfmpegArgs(caps: FfmpegCapabilities, s: StreamArgs): string[] {
  const input: string[] = ['-hide_banner', '-loglevel', 'warning']
  if (caps.hwaccel === 'vaapi')
    input.push('-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128', '-hwaccel_output_format', 'vaapi')
  else if (caps.hwaccel === 'qsv')
    input.push('-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv')

  // TCP, not UDP: Protect's RTSPS is TLS and UDP loses frames on a busy LAN.
  input.push('-rtsp_transport', 'tcp', '-i', s.url)

  // `-f rtp` carries exactly ONE stream, so audio cannot ride along with video:
  // it needs a second output aimed at the port HomeKit prepared for it. Without
  // audio the input's audio track is dropped outright.
  const video = [
    ...(s.audio ? ['-map', '0:v:0'] : ['-an']),
    '-c:v',
    caps.encoder,
    '-b:v',
    `${s.bitrate}k`,
    '-payload_type',
    String(s.video.payloadType),
    '-ssrc',
    String(s.video.ssrc),
    '-f',
    'rtp',
    '-srtp_out_suite',
    SRTP_SUITE,
    '-srtp_out_params',
    s.video.key.toString('base64'),
    destination(s.address, s.video, 1316),
  ]

  if (!s.audio)
    return [...input, ...video]

  const audio = [
    // `0:a:0?` — the `?` matters: a Protect camera with no microphone has no
    // audio track at all, and a hard mapping would make ffmpeg refuse to start.
    '-map',
    '0:a:0?',
    '-c:a',
    AAC_ELD_ENCODER,
    '-profile:a',
    'aac_eld',
    '-ac',
    '1',
    '-ar',
    `${s.audio.sampleRate}k`,
    '-b:a',
    `${s.audio.bitrate}k`,
    '-flags',
    '+global_header',
    '-payload_type',
    String(s.audio.payloadType),
    '-ssrc',
    String(s.audio.ssrc),
    '-f',
    'rtp',
    '-srtp_out_suite',
    SRTP_SUITE,
    '-srtp_out_params',
    s.audio.key.toString('base64'),
    destination(s.address, s.audio, 188),
  ]

  return [...input, ...video, ...audio]
}

export interface CameraStreamSettings {
  quality: QualityPreference
  audio: boolean
}

interface DelegateOptions {
  deviceId: string
  label: string
  log: { info: (m: string) => void, warn: (m: string) => void, debug: (m: string) => void }
  client: Pick<ProtectClient, 'getSnapshot'>
  urls: Pick<StreamUrls, 'get'>
  caps: FfmpegCapabilities
  settings: () => CameraStreamSettings
  spawn?: SpawnFn
  maxStreams?: number
  /** Injected in tests; production lists encoders with the probed ffmpeg. */
  run?: RunFfmpeg
}

/** What prepareStream knows. The payload types only arrive with the start request. */
interface SessionRtp {
  address: string
  video: Omit<RtpTarget, 'payloadType'>
  audio: Omit<RtpTarget, 'payloadType'>
}

interface SessionRequest {
  width: number
  height: number
  fps: number
  bitrate: number
  videoPayloadType: number
  audio?: { payloadType: number, sampleRate: number, bitrate: number }
}

const SNAPSHOT_TTL_MS = 2_000

/**
 * Slots taken between the cap check and the spawn. The cap counts running
 * ffmpeg processes, and there is an await (the stream URL, sometimes an encoder
 * probe) before the first one exists — without this, two cold starts racing
 * could both pass a cap of two and leave three transcodes running. Module-level
 * for the same reason the cap is: the budget belongs to the host.
 */
let reservedSlots = 0

/** `type` is a string const enum; comparing it directly would need a value import of hap-nodejs. */
function isStart(request: StreamingRequest): request is StartStreamRequest {
  return (request.type as string) === 'start'
}

/**
 * ponytail: bind-then-close leaves a window where something else can take the
 * port. Node offers nothing better, and every camera plugin does exactly this.
 */
async function reservePort(ipv6: boolean): Promise<number> {
  const socket = createSocket(ipv6 ? 'udp6' : 'udp4')
  try {
    await new Promise<void>(resolve => socket.bind(0, resolve))
    return socket.address().port
  }
  finally {
    socket.close()
  }
}

export class StreamingDelegate implements CameraStreamingDelegate {
  private readonly sessions = new Map<string, FfmpegProcess>()
  private readonly prepared = new Map<string, SessionRtp>()
  private snapshotCache?: { at: number, jpeg: Buffer }
  private audioEncoder?: Promise<string | undefined>
  private warnedAboutAudio = false

  constructor(private readonly options: DelegateOptions) {}

  /**
   * Sessions belonging to THIS camera. The concurrency cap is deliberately not
   * measured from here — see maxStreams.
   */
  get activeCount(): number {
    return this.sessions.size
  }

  get maxStreams(): number {
    return this.options.maxStreams ?? defaultMaxStreams(this.options.caps)
  }

  /**
   * Protect serves JPEGs directly, so a snapshot costs no transcode at all.
   * HomeKit polls snapshots far more eagerly than expected; the short cache
   * keeps that off the console.
   *
   * ponytail: caches the result, not the in-flight promise, so two simultaneous
   * first polls both reach the console. Dedupe the promise if that ever shows up.
   */
  async snapshot(): Promise<Buffer> {
    const now = performance.now()
    if (this.snapshotCache && now - this.snapshotCache.at < SNAPSHOT_TTL_MS)
      return this.snapshotCache.jpeg
    try {
      const jpeg = await this.options.client.getSnapshot(this.options.deviceId, {})
      this.snapshotCache = { at: now, jpeg }
      return jpeg
    }
    catch (error) {
      // The string only. `log.error(err)` uses util.inspect, which would print
      // error.cause — the path that leaked the API key in this repo before.
      this.options.log.warn(`Could not fetch a snapshot for "${this.options.label}": ${errorMessage(error)}`)
      throw error
    }
  }

  /**
   * Resolves to the AAC-ELD encoder if this ffmpeg has it. HomeKit accepts no
   * other audio codec, and plenty of ffmpeg builds — including some Homebridge
   * container images — ship without libfdk_aac because of its licence.
   *
   * ponytail: probed once per delegate and cached, failures included, so a
   * transient probe failure means video-only until restart. Key it by path with
   * a retry if that ever bites.
   */
  private probeAudioEncoder(): Promise<string | undefined> {
    this.audioEncoder ??= (this.options.run ?? runFfmpeg)(this.options.caps.path, ['-hide_banner', '-encoders'])
      .then(encoders => new RegExp(`^\\s*\\S+\\s+${AAC_ELD_ENCODER}\\b`, 'm').test(encoders) ? AAC_ELD_ENCODER : undefined)
      .catch((error) => {
        this.options.log.debug(`Could not list ffmpeg audio encoders: ${errorMessage(error)}`)
        return undefined
      })
    return this.audioEncoder
  }

  /** Audio for this session, or undefined when it is off or cannot be encoded. */
  private async audioFor(request: SessionRequest, rtp: SessionRtp, wanted: boolean): Promise<AudioStreamArgs | undefined> {
    if (!wanted || !request.audio)
      return undefined
    if (await this.probeAudioEncoder())
      return { ...rtp.audio, ...request.audio }
    if (!this.warnedAboutAudio) {
      this.warnedAboutAudio = true
      this.options.log.warn(`Audio is enabled for "${this.options.label}" but this ffmpeg cannot encode AAC-ELD (${AAC_ELD_ENCODER} is missing), which is the only codec HomeKit accepts. Streaming video only.`)
    }
    return undefined
  }

  async startSession(sessionId: string, request: SessionRequest, rtp: SessionRtp): Promise<boolean> {
    // HOST-WIDE, not per-camera. Each camera has its own delegate, so counting
    // this.sessions here would give five cameras five independent caps — up to
    // 30 concurrent transcodes on hardware, or 10 on the software path at
    // ~2.5 cores each, which would bury a 12-thread host. FfmpegProcess.activeCount
    // is a process-wide counter for exactly this reason.
    const running = FfmpegProcess.activeCount + reservedSlots
    if (running >= this.maxStreams) {
      this.options.log.warn(`Refusing a stream for "${this.options.label}": already running ${running} of a maximum ${this.maxStreams}. Raise maxStreams only if the host can take it.`)
      return false
    }
    // Held across every await below, and released once the process is counted.
    reservedSlots++
    try {
      const settings = this.options.settings()
      const quality = selectQuality(request.width, request.height, settings.quality)
      const audio = await this.audioFor(request, rtp, settings.audio)

      let url: string
      try {
        url = await this.options.urls.get(this.options.deviceId, quality)
      }
      catch (error) {
        this.options.log.warn(`Could not start a stream for "${this.options.label}": ${errorMessage(error)}`)
        return false
      }

      // NOTHING may be logged between here and the spawn: `url` carries an auth
      // token. If an invocation ever needs logging, log redactStreamUrls(args.join(' ')).
      const args = buildFfmpegArgs(this.options.caps, {
        url,
        bitrate: request.bitrate,
        address: rtp.address,
        video: { ...rtp.video, payloadType: request.videoPayloadType },
        audio,
      })
      const proc = new FfmpegProcess({
        path: this.options.caps.path,
        args,
        log: this.options.log,
        spawn: this.options.spawn,
        onExit: () => this.sessions.delete(sessionId),
      })
      this.sessions.set(sessionId, proc)
      proc.start()
      this.options.log.info(`Live view started for "${this.options.label}" (${quality} substream, ${audio ? 'with' : 'no'} audio).`)
      return true
    }
    finally {
      reservedSlots--
    }
  }

  stopSession(sessionId: string): void {
    const proc = this.sessions.get(sessionId)
    proc?.stop()
    this.sessions.delete(sessionId)
    this.prepared.delete(sessionId)
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()])
      this.stopSession(id)
  }

  handleSnapshotRequest(_request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    this.snapshot().then(
      jpeg => callback(undefined, jpeg),
      // A fresh Error carrying the message only: HAP logs whatever it is given,
      // and the original may hold the API key in `cause`.
      error => callback(new Error(errorMessage(error))),
    )
  }

  prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    const ipv6 = request.addressVersion === 'ipv6'
    // Audio is a separate RTP stream with its own port, SSRC and key, so it
    // needs its own local port too.
    Promise.all([reservePort(ipv6), reservePort(ipv6)]).then(
      ([videoLocalPort, audioLocalPort]) => {
        const rtp: SessionRtp = {
          address: request.targetAddress,
          video: {
            port: request.video.port,
            // Any 32-bit value: HomeKit only uses it to tell streams apart.
            ssrc: Math.floor(Math.random() * 0xFFFFFFFF) + 1,
            key: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
            localPort: videoLocalPort,
          },
          audio: {
            port: request.audio.port,
            ssrc: Math.floor(Math.random() * 0xFFFFFFFF) + 1,
            key: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
            localPort: audioLocalPort,
          },
        }
        this.prepared.set(request.sessionID, rtp)
        callback(undefined, {
          video: {
            port: videoLocalPort,
            ssrc: rtp.video.ssrc,
            srtp_key: request.video.srtp_key,
            srtp_salt: request.video.srtp_salt,
          },
          audio: {
            port: audioLocalPort,
            ssrc: rtp.audio.ssrc,
            srtp_key: request.audio.srtp_key,
            srtp_salt: request.audio.srtp_salt,
          },
        })
      },
      error => callback(new Error(errorMessage(error))),
    )
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    if (!isStart(request)) {
      // Both stop and reconfigure land here. Reconfigure is ignored on purpose:
      // HomeKit only ever asks for a lower bitrate, and restarting ffmpeg costs
      // the viewer a black frame for something the encoder absorbs anyway.
      if ((request.type as string) === 'stop')
        this.stopSession(request.sessionID)
      callback()
      return
    }

    const rtp = this.prepared.get(request.sessionID)
    if (!rtp) {
      callback(new Error(`No prepared stream for session ${request.sessionID}.`))
      return
    }
    this.startSession(request.sessionID, {
      width: request.video.width,
      height: request.video.height,
      fps: request.video.fps,
      bitrate: request.video.max_bit_rate,
      // HomeKit picks the payload types per session; assuming 99 works only
      // until a controller picks anything else.
      videoPayloadType: request.video.pt,
      audio: {
        payloadType: request.audio.pt,
        // AudioStreamingSamplerate is in kHz already (8, 16 or 24).
        sampleRate: request.audio.sample_rate,
        bitrate: request.audio.max_bit_rate,
      },
    }, rtp).then(
      started => callback(started ? undefined : new Error(`Could not start a stream for "${this.options.label}".`)),
      error => callback(new Error(errorMessage(error))),
    )
  }
}
