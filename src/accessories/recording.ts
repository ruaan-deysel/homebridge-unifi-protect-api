import type { CameraRecordingConfiguration, CameraRecordingDelegate, RecordingPacket } from 'homebridge'
import type { Buffer } from 'node:buffer'
import type { FfmpegCapabilities, SpawnFn } from '../protect/ffmpeg.js'
import type { Fmp4Piece } from '../protect/fmp4.js'
import type { StreamUrls } from '../protect/stream.js'
import { errorMessage } from '../protect/errors.js'
import { FfmpegProcess, redactStreamUrls } from '../protect/ffmpeg.js'
import { Fmp4Splitter } from '../protect/fmp4.js'
import { selectQuality } from './quality.js'

/**
 * Bounded by COUNT, not by time: a stalled or slow stream must not be able to
 * grow this without limit. At the 4000 ms fragment length HomeKit negotiates,
 * 16 fragments is about 64 s — far more than the 4000 ms `prebufferLength`
 * requires, with room for fragments that run long because a keyframe arrived
 * late. Measured at roughly 250 KB per fragment on the high substream, so
 * about 4 MB per recording camera.
 */
export const PREBUFFER_FRAGMENTS = 16

/**
 * Holds the most recent fragments so a HKSV recording can start from before
 * the motion that triggered it.
 */
export class PrebufferRing {
  private init?: Buffer
  private fragments: Buffer[] = []

  accept(kind: Fmp4Piece, data: Buffer): void {
    if (kind === 'init') {
      this.init = data
      return
    }
    this.fragments.push(data)
    if (this.fragments.length > PREBUFFER_FRAGMENTS)
      this.fragments.shift()
  }

  /**
   * Undefined until the init segment has arrived: HomeKit cannot decode a
   * fragment without it, so half an answer is worse than none.
   */
  snapshot(): { init: Buffer, fragments: Buffer[] } | undefined {
    if (!this.init)
      return undefined
    return { fragments: [...this.fragments], init: this.init }
  }

  /** Keeps the init segment — it describes the stream, not a moment in it. */
  reset(): void {
    this.fragments = []
  }
}

/** HomeKit's own default, and what this hardware was measured against. */
const DEFAULT_FRAGMENT_MS = 4000

export interface RecordingArgsOptions {
  url: string
  audio: boolean
  fragmentMs: number
}

/**
 * H.264 on the GPU, AAC-LC from ffmpeg's NATIVE encoder.
 *
 * Not Opus, and this differs from live view ON PURPOSE — HKSV permits only
 * AAC-LC or AAC-ELD, while live view prefers Opus because this host's
 * hardware ffmpeg build has libopus and no libfdk_aac. The native `aac`
 * encoder is what makes hardware video and legal audio possible in one
 * process; without it the whole feature would need software encoding at
 * roughly 2.45 cores per camera, continuously. Do not "unify" these.
 *
 * Order is load-bearing: ffmpeg applies an option to the NEXT file named on the
 * command line, so `-hwaccel` must precede `-i` and every encoder option must
 * precede `pipe:1`. Anything after the output URL is silently ignored.
 */
export function recordingArgs(caps: FfmpegCapabilities, o: RecordingArgsOptions): string[] {
  const input = ['-hide_banner', '-loglevel', 'warning']
  if (caps.hwaccel === 'vaapi')
    input.push('-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128', '-hwaccel_output_format', 'vaapi')
  input.push('-rtsp_transport', 'tcp', '-i', o.url)
  return [
    ...input,
    ...(o.audio ? ['-c:a', 'aac', '-ar', '32000', '-ac', '1', '-b:a', '32k'] : ['-an']),
    '-c:v',
    caps.encoder,
    '-b:v',
    '2000k',
    '-f',
    'mp4',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration',
    String(o.fragmentMs * 1000),
    'pipe:1',
  ]
}

/** One open HDS recording stream. */
interface StreamState {
  closed: boolean
  queue: Buffer[]
  /** Resolves the generator's park when a fragment arrives or the stream closes. */
  wake?: () => void
}

export interface RecordingDelegateOptions {
  deviceId: string
  label: string
  log: { info: (m: string) => void, warn: (m: string) => void, debug: (m: string) => void }
  urls: Pick<StreamUrls, 'get'>
  caps: FfmpegCapabilities
  /**
   * The live value of `RecordingAudioActive`. A function, not a boolean: HomeKit
   * can flip it at any time, and the encoder must honour whatever it reads at
   * the moment it starts.
   */
  audioActive: () => boolean
  spawn?: SpawnFn
}

/**
 * Feeds HomeKit Secure Video: one continuously running ffmpeg per active
 * camera, its fragmented-MP4 stdout split into pieces and kept in a ring, so a
 * recording can begin before the motion that triggered it.
 */
export class RecordingDelegate implements CameraRecordingDelegate {
  readonly ring = new PrebufferRing()
  private streams = new Map<number, StreamState>()
  private proc?: FfmpegProcess
  private active = false
  private starting = false
  private config?: CameraRecordingConfiguration

  constructor(private readonly options: RecordingDelegateOptions) {}

  /** The configuration HomeKit selected, or undefined before it has selected one. */
  get configuration(): CameraRecordingConfiguration | undefined {
    return this.config
  }

  /** True while the prebuffer encoder is running. */
  get encoding(): boolean {
    return this.proc?.running === true
  }

  updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {
    // Stored, never applied to a stream already running: HAP guarantees this is
    // called before updateRecordingActive(true), so the next encoder start is
    // the right place for it.
    this.config = configuration
  }

  updateRecordingActive(active: boolean): void {
    this.active = active
    if (!active) {
      this.stopEncoder()
      return
    }
    void this.startEncoder()
  }

  private stopEncoder(): void {
    this.proc?.stop()
    this.proc = undefined
    // Fragments only — the ring keeps its init segment, and a restart replaces
    // it anyway (see onPiece).
    this.ring.reset()
  }

  private async startEncoder(): Promise<void> {
    if (this.proc?.running || this.starting)
      return
    this.starting = true
    try {
      // `Resolution` is a [width, height, fps] tuple.
      const resolution = this.config?.videoCodec.resolution
      const quality = resolution ? selectQuality(resolution[0], resolution[1]) : 'high'
      const url = await this.options.urls.get(this.options.deviceId, quality)
      // Re-checked after the await: updateRecordingActive(false) may have landed
      // while the stream URL was being fetched, and a process spawned after it
      // is in no field anything will ever stop.
      if (!this.active) {
        this.options.log.debug(`Not starting the recording encoder for "${this.options.label}": recording was switched off.`)
        return
      }
      const audio = this.options.audioActive()
      // No logging of `url` or `args` from here to the spawn. The RTSPS URL
      // carries an auth token, and ffmpeg echoes its own argv on failure.
      const splitter = new Fmp4Splitter((kind, data) => this.onPiece(kind, data))
      const proc = new FfmpegProcess({
        path: this.options.caps.path,
        args: recordingArgs(this.options.caps, {
          url,
          audio,
          fragmentMs: this.config?.mediaContainerConfiguration.fragmentLength ?? DEFAULT_FRAGMENT_MS,
        }),
        log: this.options.log,
        spawn: this.options.spawn,
        // stdout is binary media: pushed straight into the splitter, never
        // logged, never retained for diagnostics.
        onStdout: (chunk) => {
          try {
            splitter.push(chunk)
          }
          catch (error) {
            // A corrupt box length. Kill the encoder rather than spin: the
            // splitter cannot recover its framing from here.
            this.options.log.warn(`Recording stream for "${this.options.label}" is unreadable: ${errorMessage(error)}`)
            this.stopEncoder()
          }
        },
        onExit: () => {
          if (this.proc === proc)
            this.proc = undefined
        },
      })
      this.proc = proc
      proc.start()
      this.options.log.info(`Recording prebuffer started for "${this.options.label}" (${quality} substream, ${audio ? 'with' : 'no'} audio).`)
    }
    catch (error) {
      this.proc = undefined
      this.options.log.warn(`Could not start the recording encoder for "${this.options.label}": ${redactStreamUrls(errorMessage(error))}`)
    }
    finally {
      this.starting = false
    }
  }

  /**
   * A SECOND init segment means the encoder restarted, and every fragment still
   * buffered was encoded against the PREVIOUS one. Handing HomeKit a clip whose
   * early fragments do not match the init segment it was given is a corrupt
   * recording that fails silently — so the fragments go, and only the fragments.
   * `PrebufferRing.accept` deliberately does not do this itself: its contract is
   * that an init segment is never dropped.
   */
  private onPiece(kind: Fmp4Piece, data: Buffer): void {
    if (kind === 'init' && this.ring.snapshot() !== undefined)
      this.ring.reset()
    this.ring.accept(kind, data)
    if (kind !== 'fragment')
      return
    for (const state of this.streams.values()) {
      state.queue.push(data)
      state.wake?.()
      state.wake = undefined
    }
  }

  async* handleRecordingStreamRequest(streamId: number): AsyncGenerator<RecordingPacket> {
    const snapshot = this.ring.snapshot()
    if (!snapshot) {
      // Nothing decodable to send. Returning empty is what tells HomeKit the
      // clip is over; yielding a fragment without its init segment would not be.
      this.options.log.warn(`Cannot record "${this.options.label}": the encoder has not produced an init segment yet.`)
      return
    }
    const state: StreamState = { closed: false, queue: [...snapshot.fragments] }
    this.streams.set(streamId, state)
    this.options.log.info(`Recording started for "${this.options.label}" (${state.queue.length} prebuffered fragments).`)
    let fragments = 0
    try {
      let packet: Buffer | undefined = snapshot.init
      while (packet !== undefined) {
        // The last packet is the one with nothing behind it AND no more coming.
        const isLast = state.closed && state.queue.length === 0
        yield { data: packet, isLast }
        if (isLast)
          return
        if (state.queue.length === 0 && !state.closed) {
          await new Promise<void>((resolve) => {
            state.wake = resolve
          })
          state.wake = undefined
        }
        packet = state.queue.shift()
        if (packet !== undefined)
          fragments++
      }
    }
    finally {
      this.streams.delete(streamId)
      this.options.log.info(`Recording for "${this.options.label}" ended after ${fragments} fragments.`)
    }
  }

  /**
   * Stops the generator only. The encoder keeps running because it IS the
   * prebuffer: killing it here would leave the next motion event with nothing
   * to record from before the trigger, which is the whole point of HKSV.
   * `updateRecordingActive(false)` is what stops it.
   */
  closeRecordingStream(streamId: number): void {
    const state = this.streams.get(streamId)
    if (!state)
      return
    state.closed = true
    state.wake?.()
    state.wake = undefined
  }
}
