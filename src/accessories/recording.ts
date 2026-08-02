import type { CameraRecordingConfiguration, CameraRecordingDelegate, RecordingPacket } from 'homebridge'
import type { Buffer } from 'node:buffer'
import type { FfmpegCapabilities, SpawnFn } from '../protect/ffmpeg.js'
import type { Fmp4Piece } from '../protect/fmp4.js'
import type { StreamUrls } from '../protect/stream.js'
import type { QualityPreference } from './quality.js'
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
 *
 * CEILING, deliberately not addressed here: the negotiated
 * `videoCodec.parameters` (bitrate, profile, level, iFrameInterval) and
 * `audioCodec.samplerate` are ignored, and with no `-g` the real fragment
 * length follows the camera's GOP rather than the negotiated 4 s. Honouring
 * them changes what the hardware encoder is asked to do, so it belongs on the
 * hardware-gate list, against a real console, not in a fix wave.
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
  /**
   * The live per-camera `quality` setting, same shape and for the same reason as
   * `audioActive`. Live view honours it; recording ignoring it would mean a user
   * who pinned `low` to save bandwidth still paid for the high substream every
   * minute of every day.
   */
  quality?: () => QualityPreference
  spawn?: SpawnFn
}

/** How long after an unexpected exit the encoder is restarted. */
export const RESTART_DELAY_MS = 10_000
/** An encoder that lived at least this long counts as having worked. */
const HEALTHY_RUN_MS = 60_000
/**
 * Consecutive short-lived runs before restarting is abandoned. A camera that is
 * unplugged, re-addressed or simply broken must not be respawned forever: five
 * tries spans a minute of retrying, which covers a reboot, and stopping after
 * that costs only the next `updateRecordingActive(true)` to resume.
 */
export const MAX_RESTARTS = 5

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
  private restartTimer?: ReturnType<typeof setTimeout>
  private failures = 0

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
    // Fresh intent from HomeKit: whatever kept failing before, try again.
    this.failures = 0
    void this.startEncoder()
  }

  private stopEncoder(): void {
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    // A kill that was NOT delivered leaves an orphan holding a slot, and
    // `encoding` would report false while it still runs — the next start would
    // then spawn a SECOND encoder against the same camera. Keep the handle so a
    // later stop can retry; only its own exit clears it.
    if (this.proc?.stop() !== false)
      this.proc = undefined
    this.teardown()
  }

  /**
   * Everything that must happen when fragments stop arriving, whichever way the
   * encoder ended.
   *
   * Open streams are closed and woken: a generator parked on a `wake` that only
   * a fragment can resolve is a stream hap-nodejs has to time out, and it warns
   * about exactly that after 10 s. The ring keeps its init segment — that
   * describes the stream rather than a moment in it, and `onPiece` replaces it
   * when a restart produces a new one — but the fragments go, because serving
   * the next clip footage from a dead encoder is stale at best and mismatched
   * against a replaced init at worst.
   */
  private teardown(): void {
    this.ring.reset()
    for (const [id, state] of this.streams) {
      state.closed = true
      state.wake?.()
      state.wake = undefined
      this.streams.delete(id)
    }
  }

  private async startEncoder(): Promise<void> {
    if (this.proc?.running || this.starting)
      return
    this.starting = true
    try {
      // `Resolution` is a [width, height, fps] tuple.
      const resolution = this.config?.videoCodec.resolution
      const preference = this.options.quality?.()
      const quality = resolution
        ? selectQuality(resolution[0], resolution[1], preference)
        : (preference === undefined || preference === 'auto' ? 'high' : preference)
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
      const startedAt = Date.now()
      const proc = new FfmpegProcess({
        path: this.options.caps.path,
        args: recordingArgs(this.options.caps, {
          url,
          audio,
          fragmentMs: this.config?.mediaContainerConfiguration.fragmentLength ?? DEFAULT_FRAGMENT_MS,
        }),
        log: this.options.log,
        spawn: this.options.spawn,
        // NOT counted against the host-wide maxStreams cap. That cap exists to
        // protect interactive viewing, and a recorder is not an interactive
        // viewer: counting it would let six recording cameras refuse every live
        // view on hardware, or two on the software path. Talkback is excluded
        // for the same reason.
        counted: false,
        // stdout is binary media: pushed straight into the splitter, never
        // logged, never retained for diagnostics.
        onStdout: (chunk) => {
          try {
            splitter.push(chunk)
          }
          catch (error) {
            // A corrupt box length. Kill the encoder rather than spin: the
            // splitter cannot recover its framing from here.
            this.options.log.warn(`Recording stream for "${this.options.label}" is unreadable: ${redactStreamUrls(errorMessage(error))}`)
            // Kill it, but leave the restart path alone: a corrupt box may well
            // be a one-off, and stopEncoder() here would take HKSV down for
            // this camera until HomeKit next toggled Active.
            proc.stop()
          }
        },
        onExit: () => {
          // A newer process means this exit belongs to one already replaced.
          if (this.proc !== undefined && this.proc !== proc)
            return
          this.proc = undefined
          this.teardown()
          const seconds = Math.round((Date.now() - startedAt) / 1000)
          // A CLEAN exit — RTSP EOF, a camera reboot — logs nothing at all in
          // FfmpegProcess, which only warns on a non-zero code. The one feature
          // whose point is running continuously must say when it stopped.
          this.options.log.info(`Recording prebuffer for "${this.options.label}" stopped after ${seconds}s.`)
          this.scheduleRestart(Date.now() - startedAt)
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
   * Recording is the one feature that is supposed to run unattended for weeks,
   * so an exit nobody restarts means HKSV is dead for that camera until HomeKit
   * happens to toggle Active — which it may not do for days. It restarts, but
   * NOT unconditionally: a camera that is unplugged or misconfigured would
   * otherwise be respawned forever, and a fast-failing loop is worse than being
   * down, because it also fills the log. So a run that lasted counts as working
   * and clears the tally, and MAX_RESTARTS short runs in a row stop the loop
   * with one line saying so.
   *
   * ponytail: a fixed delay, not exponential backoff — five tries and stop is
   * already bounded; add backoff only if the retries themselves become a cost.
   */
  private scheduleRestart(lifetimeMs: number): void {
    if (!this.active)
      return
    this.failures = lifetimeMs >= HEALTHY_RUN_MS ? 0 : this.failures + 1
    if (this.failures > MAX_RESTARTS) {
      this.options.log.warn(`Giving up on the recording encoder for "${this.options.label}" after ${MAX_RESTARTS} failed restarts. Recording will resume if HomeKit re-enables it.`)
      return
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      void this.startEncoder()
    }, RESTART_DELAY_MS)
    // Never hold the event loop open for a retry.
    this.restartTimer.unref?.()
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
      if (state.closed)
        continue
      // Bounded for the same reason the ring is, and at the same count: a
      // consumer more than PREBUFFER_FRAGMENTS behind (about a minute, ~4 MB)
      // is not catching up. The clip is ENDED rather than trimmed — dropping
      // the oldest queued fragment would hand HomeKit a clip with a silent
      // hole in the middle, which decodes as corruption; a short clip that
      // ends cleanly is a clip.
      if (state.queue.length >= PREBUFFER_FRAGMENTS) {
        this.options.log.warn(`Ending the recording for "${this.options.label}": HomeKit is more than ${PREBUFFER_FRAGMENTS} fragments behind.`)
        state.closed = true
      }
      else {
        state.queue.push(data)
      }
      state.wake?.()
      state.wake = undefined
    }
  }

  /**
   * Deliberately NOT an `async*`: the body of an async generator does not run
   * until the first `next()`, so registering the stream inside one would lose
   * every fragment produced between the request and HAP's first pull. The
   * state is registered here, synchronously, and the packets come from a
   * separate generator.
   */
  handleRecordingStreamRequest(streamId: number): AsyncGenerator<RecordingPacket> {
    const snapshot = this.ring.snapshot()
    if (!snapshot) {
      // Nothing decodable to send. Returning empty is what tells HomeKit the
      // clip is over; yielding a fragment without its init segment would not be.
      this.options.log.warn(`Cannot record "${this.options.label}": the encoder has not produced an init segment yet.`)
      return (async function* () {})()
    }
    const state: StreamState = { closed: false, queue: [...snapshot.fragments] }
    this.streams.set(streamId, state)
    this.options.log.info(`Recording started for "${this.options.label}" (${state.queue.length} prebuffered fragments).`)
    return this.streamPackets(streamId, state, snapshot.init)
  }

  /**
   * One packet is always held back, because `isLast` cannot be known about a
   * packet until something else happens: either another fragment arrives, or
   * the stream closes. Yielding eagerly and deciding afterwards is what let a
   * generator finish with every packet flagged `isLast: false` — hap-nodejs
   * then has no way to tell the controller the clip ended.
   */
  private async* streamPackets(streamId: number, state: StreamState, init: Buffer): AsyncGenerator<RecordingPacket> {
    let fragments = 0
    try {
      let packet = init
      for (;;) {
        while (state.queue.length === 0 && !state.closed) {
          await new Promise<void>((resolve) => {
            state.wake = resolve
          })
          state.wake = undefined
        }
        const next = state.queue.shift()
        yield { data: packet, isLast: next === undefined }
        if (next === undefined)
          return
        packet = next
        fragments++
      }
    }
    finally {
      if (this.streams.get(streamId) === state)
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
    // A stream HAP closed before ever pulling from it has no generator body to
    // reach the finally that would otherwise remove it.
    this.streams.delete(streamId)
  }
}
