import type {
  AudioStreamingCodec,
  AudioStreamingOptions,
  AudioStreamingSamplerate,
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
import type { Quality, QualityPreference } from './quality.js'
import { Buffer } from 'node:buffer'
import { createSocket } from 'node:dgram'
import { errorMessage } from '../protect/errors.js'
import { FfmpegProcess, hasEncoder, redactStreamUrls, runFfmpeg } from '../protect/ffmpeg.js'
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

export type AudioCodec = 'aac-eld' | 'opus'

/**
 * The two codecs HomeKit accepts that this plugin can produce, each with the
 * ffmpeg encoder that makes it and the name HomeKit knows it by. Advertising one
 * and sending the other fails on the client, so these must never drift apart —
 * hence one table, used by both the advertisement and the argument builder.
 */
export const AUDIO_CODECS = {
  'opus': { encoder: 'libopus', hapType: 'OPUS' },
  'aac-eld': { encoder: 'libfdk_aac', hapType: 'AAC-eld' },
} as const satisfies Record<AudioCodec, { encoder: string, hapType: string }>

/**
 * Opus first, and it matters on the real target: the container's two ffmpeg
 * builds have mutually exclusive capabilities — `/usr/bin/ffmpeg` has VAAPI and
 * QSV but no libfdk_aac, the bundled static build has libfdk_aac but no hardware.
 * Preferring AAC-ELD would mean choosing between hardware video and any audio at
 * all. libopus is in the hardware build, and the Protect source already carries
 * an opus 48 kHz track alongside its AAC one.
 */
export const AUDIO_CODEC_PREFERENCE: AudioCodec[] = ['opus', 'aac-eld']

/** The best codec this ffmpeg can produce, or undefined for video-only. */
export function chooseAudioCodec(encoders: string): AudioCodec | undefined {
  return AUDIO_CODEC_PREFERENCE.find(codec => hasEncoder(encoders, AUDIO_CODECS[codec].encoder))
}

/**
 * What to put in `streamingOptions.audio.codecs`. HomeKit picks a sample rate
 * from this list and echoes it back in the start request; 16 and 24 kHz are what
 * controllers actually ask for.
 */
export function audioStreamingCodec(codec: AudioCodec): AudioStreamingCodec {
  return {
    type: AUDIO_CODECS[codec].hapType,
    audioChannels: 1,
    samplerate: [16, 24] as AudioStreamingSamplerate[],
  }
}

export interface AudioStreamArgs extends RtpTarget {
  codec: AudioCodec
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
  /** Absent means video-only: either the camera opted out or no codec is available. */
  audio?: AudioStreamArgs
  /**
   * Output frame rate. Supplied only for the package lens, which the console
   * serves at 2 fps — HomeKit negotiates a rate and can treat a 2 fps feed as a
   * stalled stream, so ffmpeg duplicates frames up to this rate. It does that
   * unprompted anyway (a 15 s sample reported `dup=8`), and duplicated frames
   * compress to almost nothing.
   */
  fps?: number
  /**
   * Output size. Supplied only for the package lens, which has a single
   * 1600x1200 stream and no substream to pick from, so without a scale filter
   * every advertised resolution below (or above) that would be a promise the
   * encoder does not keep. Main cameras select a substream that already
   * approximates the request and need no filter.
   */
  scale?: { width: number, height: number }
}

const SRTP_SUITE = 'AES_CM_128_HMAC_SHA1_80'

/**
 * The top of the ladder `packageVideoStreamingOptions` (src/platform.ts)
 * advertises, and the rate every entry on it offers. Only the package lens
 * supplies `scale`/`fps`, so this is the bound for both. Keep the two in step:
 * a larger entry there without a change here would be clamped away.
 */
const ADVERTISED_MAX = { width: 1600, height: 1200, fps: 30 }

/**
 * hap-nodejs does NOT check a paired controller's selection against the ladder
 * we advertised — whatever it sends lands here verbatim. `fps: 0` would become
 * `-r 0`, which ffmpeg rejects outright, so the viewer gets nothing; an absurd
 * width would become a scale filter that allocates before it fails.
 *
 * CLAMPED, not rejected, deliberately: every value this can produce is one we
 * already offered, and a viewer getting a slightly different size beats a viewer
 * getting a failed stream. Non-finite input falls back to the top of the ladder
 * — the lens's native size and rate — rather than to a guess.
 */
function clampDimension(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0)
    return max
  // Even, because H.264's 4:2:0 chroma has no half-pixels: an odd width would
  // fail the encoder rather than merely look wrong. Clamped BEFORE the bitwise
  // round, which is only defined on 32-bit values.
  return Math.max(2, Math.min(Math.round(value), max) & ~1)
}

function clampFps(value: number): number {
  // Below 1 (0, negative, a fraction) has no valid `-r`; NaN and Infinity have
  // none either. Math.min/max would happily propagate NaN, hence the explicit test.
  if (!Number.isFinite(value) || value < 1)
    return ADVERTISED_MAX.fps
  return Math.min(Math.round(value), ADVERTISED_MAX.fps)
}

function destination(address: string, target: RtpTarget, packetSize: number): string {
  const host = address.includes(':') ? `[${address}]` : address
  const local = target.localPort === undefined ? '' : `&localrtcpport=${target.localPort}`
  return `srtp://${host}:${target.port}?rtcpport=${target.port}${local}&pkt_size=${packetSize}`
}

/**
 * Software scale, then `hwupload` so the hardware encoder gets a GPU surface.
 * Frames are in system memory here because the scaling path decodes in software
 * — see buildFfmpegArgs. The QSV form mirrors the working probe in
 * `viabilityArgs`, `extra_hw_frames` and all.
 */
function scaleFilter(caps: FfmpegCapabilities, size: { width: number, height: number }): string {
  const scale = `scale=${size.width}:${size.height}`
  if (caps.hwaccel === 'vaapi')
    return `${scale},format=nv12,hwupload`
  if (caps.hwaccel === 'qsv')
    return `${scale},format=nv12,hwupload=extra_hw_frames=64`
  return scale
}

export function buildFfmpegArgs(caps: FfmpegCapabilities, s: StreamArgs): string[] {
  // Validated HERE rather than at the call site so every caller is covered by
  // the one guard: these are the only two negotiated numbers that reach ffmpeg
  // as arguments. The main-camera path supplies neither and is untouched.
  const scale = s.scale && {
    width: clampDimension(s.scale.width, ADVERTISED_MAX.width),
    height: clampDimension(s.scale.height, ADVERTISED_MAX.height),
  }
  const fps = s.fps === undefined ? undefined : clampFps(s.fps)

  const input: string[] = ['-hide_banner', '-loglevel', 'warning']
  if (scale) {
    // The scaling path — the package lens, and only it — decodes in SOFTWARE and
    // hands the encoder an uploaded surface. WHY: in-GPU `scale_vaapi` dies on the
    // reference hardware (Intel UHD 630, ffmpeg 6.x) with "Cannot allocate memory"
    // injecting frames into the filter graph — verified live, and `-extra_hw_frames`
    // (16 and 32, with and without `:format=nv12`) does not help. The trade is only
    // affordable BECAUSE it is the package lens: 1600x1200 at 2 fps, so software
    // decoding it is trivial. The main lens is 4 MP at 30 fps, where hardware decode
    // is worth roughly 27x the CPU — hence this branch, not a blanket change.
    if (caps.hwaccel === 'vaapi')
      input.push('-vaapi_device', '/dev/dri/renderD128')
    else if (caps.hwaccel === 'qsv')
      input.push('-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw')
  }
  else if (caps.hwaccel === 'vaapi') {
    input.push('-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128', '-hwaccel_output_format', 'vaapi')
  }
  else if (caps.hwaccel === 'qsv') {
    input.push('-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv')
  }

  // TCP, not UDP: Protect's RTSPS is TLS and UDP loses frames on a busy LAN.
  input.push('-rtsp_transport', 'tcp', '-i', s.url)

  // `-f rtp` carries exactly ONE stream, so audio cannot ride along with video:
  // it needs a second output aimed at the port HomeKit prepared for it. Without
  // audio the input's audio track is dropped outright.
  const video = [
    ...(s.audio ? ['-map', '0:v:0'] : ['-an']),
    // Like `-r` below, an OUTPUT option: it must precede `-f rtp` and the
    // output URL or ffmpeg never applies it.
    ...(scale ? ['-vf', scaleFilter(caps, scale)] : []),
    '-c:v',
    caps.encoder,
    '-b:v',
    `${s.bitrate}k`,
    '-payload_type',
    String(s.video.payloadType),
    '-ssrc',
    String(s.video.ssrc),
    // ffmpeg applies output options to the output that FOLLOWS them, so `-r`
    // must sit here, before `-f rtp` — after the output URL it is dangling and
    // never reaches the encoder. This is the frame-rate padding the package
    // lens depends on to avoid looking like a stalled stream to HomeKit.
    ...(fps !== undefined ? ['-r', String(fps)] : []),
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

  // Opus wants low-delay framing; AAC-ELD wants its profile named.
  const codec = s.audio.codec === 'opus'
    ? ['-c:a', AUDIO_CODECS.opus.encoder, '-application', 'lowdelay', '-frame_duration', '20']
    : ['-c:a', AUDIO_CODECS['aac-eld'].encoder, '-profile:a', 'aac_eld']

  const audio = [
    // `0:a:0?` — the `?` matters: a Protect camera with no microphone has no
    // audio track at all, and a hard mapping would make ffmpeg refuse to start.
    '-map',
    '0:a:0?',
    ...codec,
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
  /**
   * Set to 'package' for the Doorbell's downward lens. It is a CHANNEL, not a
   * quality tier: the package stream has exactly one variant, so substream
   * selection does not apply and `selectQuality` is never consulted.
   */
  channel?: 'package'
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

/**
 * A synchronisation source, in the range HomeKit and ffmpeg's `-ssrc` actually
 * accept: a POSITIVE SIGNED 32-bit integer. `random() * 0xFFFFFFFF + 1` reaches
 * 0x100000000, so a fraction of streams got a malformed SSRC and simply never
 * loaded — intermittent, and invisible to anything but the viewer.
 */
export function randomSsrc(): number {
  return Math.floor(Math.random() * 0x7FFFFFFF) + 1
}

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
    // `once('error')`, not just the bind callback: a failed bind never calls
    // back, so without this the promise never settles — prepareStream hangs and
    // takes its reserved slot with it. An unhandled dgram 'error' also throws.
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(0, resolve)
    })
    return socket.address().port
  }
  finally {
    // Closing a socket that never bound throws; the bind failure is the real error.
    try {
      socket.close()
    }
    catch {}
  }
}

export class StreamingDelegate implements CameraStreamingDelegate {
  private readonly sessions = new Map<string, FfmpegProcess>()
  private readonly prepared = new Map<string, SessionRtp>()
  private snapshotCache?: { at: number, jpeg: Buffer }
  private audioCodec?: Promise<AudioCodec | undefined>
  private warnedAboutAudio = false
  /** Latched by stopAll(). See the check in startSession. */
  private shuttingDown = false

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
   * The channel goes with the request: without it the package accessory's tile
   * shows the MAIN lens. The cache lives on the instance and each lens has its
   * own delegate, so the two can never serve each other's image.
   *
   * ponytail: caches the result, not the in-flight promise, so two simultaneous
   * first polls both reach the console. Dedupe the promise if that ever shows up.
   */
  async snapshot(): Promise<Buffer> {
    const now = performance.now()
    if (this.snapshotCache && now - this.snapshotCache.at < SNAPSHOT_TTL_MS)
      return this.snapshotCache.jpeg
    try {
      const jpeg = await this.options.client.getSnapshot(this.options.deviceId, this.options.channel === 'package' ? { channel: 'package' } : {})
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
   * The audio codec this ffmpeg can produce, or undefined for video-only.
   *
   * ponytail: probed once per delegate and cached, failures included, so a
   * transient probe failure means video-only until restart. Key it by path with
   * a retry if that ever bites.
   */
  private probeAudioCodec(): Promise<AudioCodec | undefined> {
    this.audioCodec ??= (this.options.run ?? runFfmpeg)(this.options.caps.path, ['-hide_banner', '-encoders'])
      .then(chooseAudioCodec)
      .catch((error) => {
        this.options.log.debug(`Could not list ffmpeg audio encoders: ${errorMessage(error)}`)
        return undefined
      })
    return this.audioCodec
  }

  /**
   * What to advertise in `CameraControllerOptions.streamingOptions.audio`, or
   * undefined when this camera streams video only. It MUST name the codec the
   * ffmpeg arguments actually produce: advertising one and sending another fails
   * on the client, where no unit test is watching.
   */
  async audioStreamingOptions(): Promise<AudioStreamingOptions | undefined> {
    // The package lens carries audio, but from the SAME microphone as the main
    // lens. Two identical audio sources on one physical device benefits nobody.
    // (Also enforced in startSession's audioFor() call — see the comment there;
    // this guard is deliberately redundant with it, not a leftover to prune.)
    if (this.options.channel === 'package')
      return undefined
    if (!this.options.settings().audio)
      return undefined
    const codec = await this.probeAudioCodec()
    return codec ? { codecs: [audioStreamingCodec(codec)] } : undefined
  }

  /**
   * The package lens has one stream; every other camera selects a substream.
   * The resolved channel comes back with the URL so the session logs the
   * channel it actually streams — re-reading the settings later would name a
   * different one after a mid-session settings change.
   */
  async streamUrlFor(request: { width: number, height: number }): Promise<{ url: string, channel: Quality | 'package' }> {
    const channel = this.options.channel === 'package'
      ? 'package'
      : selectQuality(request.width, request.height, this.options.settings().quality)
    return { url: await this.options.urls.get(this.options.deviceId, channel), channel }
  }

  /** Audio for this session, or undefined when it is off or cannot be encoded. */
  private async audioFor(request: SessionRequest, rtp: SessionRtp, wanted: boolean): Promise<AudioStreamArgs | undefined> {
    if (!wanted || !request.audio)
      return undefined
    const codec = await this.probeAudioCodec()
    if (codec)
      return { ...rtp.audio, ...request.audio, codec }
    if (!this.warnedAboutAudio) {
      this.warnedAboutAudio = true
      const encoders = AUDIO_CODEC_PREFERENCE.map(c => AUDIO_CODECS[c].encoder).join(' or ')
      this.options.log.warn(`Audio is enabled for "${this.options.label}" but this ffmpeg can encode neither of the codecs HomeKit accepts here (${encoders} is missing). Streaming video only.`)
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
      const isPackage = this.options.channel === 'package'
      // No audio on the package path, whatever the camera's audio setting says
      // — see audioStreamingOptions for why. That guard covers what HomeKit is
      // TOLD is available; this one covers what a session actually SENDS, and
      // both must stay in place — this is deliberate redundancy, not a leftover.
      const audio = await this.audioFor(request, rtp, settings.audio && !isPackage)

      // Resolved ONCE, here: the channel logged at the end must be the one this
      // session actually streams, whatever the settings say by then.
      let url: string
      let channel: Quality | 'package'
      try {
        ({ url, channel } = await this.streamUrlFor(request))
      }
      catch (error) {
        this.options.log.warn(`Could not start a stream for "${this.options.label}": ${errorMessage(error)}`)
        return false
      }

      // Re-checked after every await above: stopAll() drains the session map,
      // so a process spawned after it is in no map and nothing will ever kill
      // it — it holds a 4 MP HEVC decode for as long as the host is up. This
      // must run after streamUrlFor's await to catch a stopAll() landing
      // during it, so it necessarily sits inside the no-logging window below
      // rather than above the URL fetch. It is safe there because it logs
      // only this.options.label, never url, channel, or args.
      if (this.shuttingDown) {
        this.options.log.debug(`Not starting a stream for "${this.options.label}": the plugin is shutting down.`)
        return false
      }

      // The no-logging window starts where `url` is bound above (streamUrlFor's
      // await), not here: nothing from there to the ffmpeg spawn may log `url`
      // or `args`. If an invocation ever needs logging, log
      // redactStreamUrls(args.join(' ')).
      const args = buildFfmpegArgs(this.options.caps, {
        url,
        bitrate: request.bitrate,
        address: rtp.address,
        video: { ...rtp.video, payloadType: request.videoPayloadType },
        audio,
        // The rate HomeKit negotiated, not a constant: the advertised ladder is
        // 30 fps throughout, and padding to a hardcoded 15 would under-deliver
        // against what the controller was told it would get.
        fps: isPackage ? request.fps : undefined,
        scale: isPackage ? { width: request.width, height: request.height } : undefined,
      })
      const proc: FfmpegProcess = new FfmpegProcess({
        path: this.options.caps.path,
        args,
        log: this.options.log,
        spawn: this.options.spawn,
        // Identity-checked: a process that outlived a failed kill stays in the
        // map, and HomeKit reuses session ids — its late exit must not evict
        // the live session that replaced it.
        //
        // ponytail: one entry per session id, so a new session reusing the id
        // of an orphan does displace it from the map. Key orphans separately if
        // an unkillable ffmpeg ever shows up outside a test.
        onExit: () => {
          if (this.sessions.get(sessionId) === proc)
            this.sessions.delete(sessionId)
        },
      })
      try {
        proc.start()
      }
      catch (error) {
        this.options.log.warn(`Could not start ffmpeg for "${this.options.label}": ${redactStreamUrls(errorMessage(error))}`)
        return false
      }
      // Tracked only once it is genuinely running: a spawn that throws must not
      // leave an entry behind for stopAll() to kill a corpse. A process that
      // died between spawn and here is a FAILED start — reporting success would
      // leave HomeKit waiting on a stream nobody is producing.
      if (!proc.running) {
        this.options.log.warn(`ffmpeg for "${this.options.label}" exited before the stream started.`)
        return false
      }
      this.sessions.set(sessionId, proc)
      this.options.log.info(`Live view started for "${this.options.label}" (${channel} substream, ${audio ? 'with' : 'no'} audio).`)
      return true
    }
    finally {
      reservedSlots--
    }
  }

  /**
   * Dropping the entry unconditionally used to orphan the process whenever
   * `kill()` failed: nothing else holds a handle, so nobody could ever retry,
   * and the orphan kept running — holding a decode open and a slot in the
   * host-wide cap that is only released when the process actually exits. Over
   * a long uptime the cap fills with corpses and live views get refused. A
   * process that survives its kill therefore STAYS tracked; a later
   * stopSession/stopAll retries it, and its own onExit removes it once it
   * genuinely dies, so nothing lingers forever.
   */
  stopSession(sessionId: string): void {
    const proc = this.sessions.get(sessionId)
    if (!proc || proc.stop())
      this.sessions.delete(sessionId)
    this.prepared.delete(sessionId)
  }

  stopAll(): void {
    // Latched before the drain, so a startSession parked in an await cannot slip
    // a spawn in behind it.
    this.shuttingDown = true
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
            ssrc: randomSsrc(),
            key: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
            localPort: videoLocalPort,
          },
          audio: {
            port: request.audio.port,
            ssrc: randomSsrc(),
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
