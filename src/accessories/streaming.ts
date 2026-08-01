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
import type { FfmpegCapabilities, SpawnFn } from '../protect/ffmpeg.js'
import type { StreamUrls } from '../protect/stream.js'
import type { QualityPreference } from './quality.js'
import { Buffer } from 'node:buffer'
import { createSocket } from 'node:dgram'
import { errorMessage } from '../protect/errors.js'
import { FfmpegProcess } from '../protect/ffmpeg.js'
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

export interface StreamArgs {
  url: string
  width: number
  height: number
  fps: number
  bitrate: number
  audio: boolean
  address: string
  videoPort: number
  videoSsrc: number
  videoKey: Buffer
  /** Our own RTCP port, so HomeKit's receiver reports reach this process. */
  localPort?: number
}

export function buildFfmpegArgs(caps: FfmpegCapabilities, s: StreamArgs): string[] {
  const input: string[] = ['-hide_banner', '-loglevel', 'warning']
  if (caps.hwaccel === 'vaapi')
    input.push('-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128', '-hwaccel_output_format', 'vaapi')
  else if (caps.hwaccel === 'qsv')
    input.push('-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv')

  // TCP, not UDP: Protect's RTSPS is TLS and UDP loses frames on a busy LAN.
  input.push('-rtsp_transport', 'tcp', '-i', s.url)

  // ponytail: audio currently only drops `-an`. `-f rtp` carries one stream, so
  // real audio needs its own output to HomeKit's audio port — wire that when the
  // per-camera opt-in becomes reachable from config.
  const video = s.audio ? [] : ['-an']
  const host = s.address.includes(':') ? `[${s.address}]` : s.address
  const local = s.localPort === undefined ? '' : `&localrtcpport=${s.localPort}`

  return [
    ...input,
    ...video,
    '-c:v',
    caps.encoder,
    '-b:v',
    `${s.bitrate}k`,
    '-payload_type',
    '99',
    '-ssrc',
    String(s.videoSsrc),
    '-f',
    'rtp',
    '-srtp_out_suite',
    'AES_CM_128_HMAC_SHA1_80',
    '-srtp_out_params',
    s.videoKey.toString('base64'),
    `srtp://${host}:${s.videoPort}?rtcpport=${s.videoPort}${local}&pkt_size=1316`,
  ]
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
}

interface SessionRtp {
  address: string
  videoPort: number
  videoSsrc: number
  videoKey: Buffer
  localPort: number
}

const SNAPSHOT_TTL_MS = 2_000

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

  async startSession(
    sessionId: string,
    request: { width: number, height: number, fps: number, bitrate: number },
    rtp: SessionRtp,
  ): Promise<boolean> {
    // HOST-WIDE, not per-camera. Each camera has its own delegate, so counting
    // this.sessions here would give five cameras five independent caps — up to
    // 30 concurrent transcodes on hardware, or 10 on the software path at
    // ~2.5 cores each, which would bury a 12-thread host. FfmpegProcess.activeCount
    // is a process-wide counter for exactly this reason.
    if (FfmpegProcess.activeCount >= this.maxStreams) {
      this.options.log.warn(`Refusing a stream for "${this.options.label}": already running ${FfmpegProcess.activeCount} of a maximum ${this.maxStreams}. Raise maxStreams only if the host can take it.`)
      return false
    }
    const settings = this.options.settings()
    const quality = selectQuality(request.width, request.height, settings.quality)

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
    const args = buildFfmpegArgs(this.options.caps, { ...request, ...rtp, url, audio: settings.audio })
    const proc = new FfmpegProcess({
      path: this.options.caps.path,
      args,
      log: this.options.log,
      spawn: this.options.spawn,
      onExit: () => this.sessions.delete(sessionId),
    })
    this.sessions.set(sessionId, proc)
    proc.start()
    this.options.log.info(`Live view started for "${this.options.label}" (${quality} substream, ${settings.audio ? 'with' : 'no'} audio).`)
    return true
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
    reservePort(request.addressVersion === 'ipv6').then(
      (localPort) => {
        const rtp: SessionRtp = {
          address: request.targetAddress,
          videoPort: request.video.port,
          // Any 32-bit value: HomeKit only uses it to tell streams apart.
          videoSsrc: Math.floor(Math.random() * 0xFFFFFFFF) + 1,
          videoKey: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
          localPort,
        }
        this.prepared.set(request.sessionID, rtp)
        callback(undefined, {
          video: {
            port: localPort,
            ssrc: rtp.videoSsrc,
            srtp_key: request.video.srtp_key,
            srtp_salt: request.video.srtp_salt,
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
    }, rtp).then(
      started => callback(started ? undefined : new Error(`Could not start a stream for "${this.options.label}".`)),
      error => callback(new Error(errorMessage(error))),
    )
  }
}
