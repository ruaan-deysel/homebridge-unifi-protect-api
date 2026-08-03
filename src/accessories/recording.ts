import type { CameraRecordingConfiguration, CameraRecordingDelegate, RecordingPacket } from 'homebridge'
import type { FfmpegCapabilities, SpawnFn } from '../protect/ffmpeg.js'
import type { Fmp4Piece } from '../protect/fmp4.js'
import type { StreamUrls } from '../protect/stream.js'
import type { QualityPreference } from './quality.js'
import { Buffer } from 'node:buffer'
import { errorMessage } from '../protect/errors.js'
import { FfmpegProcess, redactStreamUrls } from '../protect/ffmpeg.js'
import { Fmp4Splitter } from '../protect/fmp4.js'
import { ADVERTISED_RECORDING_SIZE, selectQuality } from './quality.js'

/**
 * Bounded by COUNT, not by time: a stalled or slow stream must not be able to
 * grow this without limit. At the 4000 ms fragment length HomeKit negotiates,
 * 16 fragments is about 64 s — far more than the 4000 ms `prebufferLength`
 * requires, with room for fragments that run long because a keyframe arrived
 * late.
 *
 * MEASURED: roughly 250 KB per fragment on the high substream, so about 4 MB
 * per recording camera. ENFORCED: nothing caps a fragment except `MAX_BOX`
 * (64 MiB) in the splitter, so the guaranteed ceiling is
 * PREBUFFER_FRAGMENTS x MAX_BOX = 1 GiB per camera — doubled again while a slow
 * HDS consumer holds a queue of the same depth (see `onPiece`). The gap between
 * the two is fine in practice only because ffmpeg cannot produce a 64 MiB
 * fragment from this hardware; it is not something this constant enforces.
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

  /**
   * Drops the init segment too, which `reset` deliberately never does. For the
   * one case where the stream itself is gone: with no encoder, an init is not
   * "the stream" any more, it is a dead encoder's, and keeping it makes
   * `snapshot()` answer a request that has nothing behind it.
   */
  clear(): void {
    this.init = undefined
    this.fragments = []
  }
}

/** HomeKit's own default, and what this hardware was measured against. */
const DEFAULT_FRAGMENT_MS = 4000

/** The body of a clip with nothing in it. See `handleRecordingStreamRequest`. */
const EMPTY_PACKET = Buffer.alloc(0)

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
  /**
   * The queue depth at which this clip is abandoned: its own pre-roll plus a
   * full ring of live backlog. Per-stream rather than a constant, because the
   * pre-roll is negotiated and a clip that opened with 15 buffered fragments
   * has not fallen behind when it holds 16.
   */
  limit: number
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
   * A function that returns the plugin's live audio setting (from
   * `settingsFor(...).audio`), read once per encoder start. NOT the
   * `RecordingAudioActive` characteristic, which this plugin does not read or
   * honour: toggling recording audio in the Home app has no effect. This is a
   * known limitation — fixing it would require access to the `CameraController`
   * instance to read the characteristic, but `attachStreaming` constructs it
   * inline and discards it. Clips are recorded with or without audio according
   * to the plugin setting, while hap-nodejs defaults `RecordingAudioActive` to
   * `false`, so users see "recording audio off" in the Home app even when clips
   * contain audio.
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
export const HEALTHY_RUN_MS = 60_000
/**
 * Consecutive short-lived runs before the retry drops to the slow cadence. Five
 * fast tries spans about a minute, which covers a stream that dropped once; a
 * camera that is unplugged, re-addressed or reflashing takes far longer than
 * that and must not be respawned every 10 s while it does.
 */
export const MAX_RESTARTS = 5
/**
 * The cadence after that. Long enough that a permanently broken camera costs one
 * spawn and one log line per ten minutes, short enough that a camera which comes
 * back is recording again without anybody touching Homebridge.
 */
export const SLOW_RESTART_DELAY_MS = 600_000

/**
 * Feeds HomeKit Secure Video: one continuously running ffmpeg per active
 * camera, its fragmented-MP4 stdout split into pieces and kept in a ring, so a
 * recording can begin before the motion that triggered it.
 *
 * Disposed via `UniFiProtectPlatform.disposeRecorder`, which calls
 * `updateRecordingActive(false)` to clear the restart timer, stop the process,
 * and run teardown. This is called both from the accessory-removal sweep and
 * from shutdown.
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
   * about exactly that after 10 s.
   *
   * The ring is CLEARED, init included. Keeping the init made `snapshot()`
   * answer requests that arrived between an exit and its restart: the request
   * succeeded, registered a stream, and parked with no encoder to wake it —
   * precisely the state this method exists to prevent — and when the restart
   * landed, that generator emitted a DEAD encoder's init followed by fragments
   * encoded against the new one, which is silent corruption. With no init,
   * `handleRecordingStreamRequest` takes its existing no-init branch and returns
   * empty, which is the honest answer when there is no encoder. Nothing is lost
   * by it: there is no encoder for at least RESTART_DELAY_MS, so the prebuffer
   * would cover a window HKSV cannot record in anyway.
   */
  private teardown(): void {
    this.ring.clear()
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
      // No negotiated configuration yet: fall back to the ONE resolution
      // `recordingOptions` advertises, 1280x720, which `selectQuality` maps to
      // the medium substream at exactly that size. This used to fall back to
      // 'high' — 2688x1512 — so a camera whose encoder started before HomeKit
      // sent a configuration recorded at more than four times the advertised
      // pixel count, and paid the GPU for it. Observed live on "Garage".
      const quality = resolution
        ? selectQuality(resolution[0], resolution[1], preference)
        : (preference === undefined || preference === 'auto' ? selectQuality(...ADVERTISED_RECORDING_SIZE) : preference)
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
      // Per-process, deliberately not a field: it answers "did THIS run produce
      // anything", and a field would still hold the previous run's answer when
      // the next one exits without producing.
      let produced = false
      const splitter = new Fmp4Splitter((kind, data) => {
        produced = true
        this.onPiece(kind, data)
      })
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
            //
            // The boolean is HONOURED, like everywhere else in this file: a kill
            // that was not delivered leaves an orphan ffmpeg producing bytes the
            // splitter now drops, and since `onExit` never fires for it nothing
            // else would ever say so. The handle is deliberately NOT cleared —
            // `this.proc` still points at it, so the next start refuses to spawn
            // a second encoder against the same camera.
            //
            // Warned at most once per process: `Fmp4Splitter` latches `broken`
            // and drops every later chunk, so this catch cannot run again.
            if (!proc.stop()) {
              // ponytail: if kill fails, this.proc stays set, the splitter keeps
              // dropping chunks (broken latch), onExit never fires, scheduleRestart
              // is unreached, and the camera's recording is dead for the life of
              // Homebridge. Upgrade: escalate to a full stopEncoder() + restart if
              // the kill fails consistently.
              this.options.log.warn(`Could not stop the unreadable recording encoder for "${this.options.label}". It may still be running.`)
            }
          }
        },
        onExit: () => {
          // STRICT identity, deliberately. Anything else — a NEWER process, or
          // `undefined` because stopEncoder already cleared the field — means
          // this exit is not the running encoder's. Letting a stale one through
          // logs a stop the user never caused and bumps `failures` for a process
          // they deliberately stopped, nudging a healthy camera towards the slow
          // cadence on its next real fault.
          //
          // It also drops the exit of a process `stopEncoder` successfully
          // killed, which is correct: that path is only reached from
          // `updateRecordingActive(false)`, which has already run `teardown()`
          // and set `active = false`, so `scheduleRestart` would return early
          // anyway. A kill that FAILED leaves `this.proc` pointing at it, so its
          // eventual exit still lands here and still clears the handle.
          if (this.proc !== proc)
            return
          this.proc = undefined
          this.teardown()
          const seconds = Math.round((Date.now() - startedAt) / 1000)
          // A CLEAN exit — RTSP EOF, a camera reboot — logs nothing at all in
          // FfmpegProcess, which only warns on a non-zero code. The one feature
          // whose point is running continuously must say when it stopped.
          this.options.log.info(`Recording prebuffer for "${this.options.label}" stopped after ${seconds}s.`)
          this.scheduleRestart(Date.now() - startedAt, produced)
        },
      })
      this.proc = proc
      proc.start()
      this.options.log.info(`Recording prebuffer started for "${this.options.label}" (${quality} substream, ${audio ? 'with' : 'no'} audio).`)
    }
    catch (error) {
      this.proc = undefined
      this.options.log.warn(`Could not start the recording encoder for "${this.options.label}": ${redactStreamUrls(errorMessage(error))}`)
      // A failed START must retry too, not only a failed RUN. Everything from
      // the stream-url fetch onwards lands here without a process, so without
      // this a single console blip during a retry would end recording for this
      // camera permanently. Counted as a failed run of zero length that produced
      // nothing, so the same ceiling applies.
      this.scheduleRestart(0, false)
    }
    finally {
      this.starting = false
    }
  }

  /**
   * Recording is the one feature that is supposed to run unattended for weeks,
   * so an exit nobody restarts means HKSV is dead for that camera until HomeKit
   * happens to toggle Active — which it may not do for days. It restarts, but
   * NOT at one rate forever: a camera that is unplugged or misconfigured fails
   * fast, and retrying it every 10 s fills the log without ever succeeding. So
   * a run that lasted HEALTHY_RUN_MS **and produced media** clears the tally,
   * and after MAX_RESTARTS unhealthy runs in a row the interval drops to
   * SLOW_RESTART_DELAY_MS.
   *
   * Both halves are load-bearing. Uptime alone was the whole test: an ffmpeg
   * that connects, stalls, and sits there for 60 s emitting no init segment and
   * no fragment reset the tally every single time, so the genuinely broken
   * camera the slow cadence exists for never reached it — it respawned every
   * 10 s forever. `produced` is the evidence that the process actually did the
   * job, and the job is bytes, not staying alive.
   *
   * It SLOWS DOWN rather than stopping. Stopping was terminal in practice: a
   * camera rebooting after a firmware update takes longer than the ~60 s the
   * fast tally spans and fails fast throughout, so the tally never cleared, and
   * nothing retried again until `updateRecordingActive(true)` — which usually
   * means a Homebridge restart, days later — while the Home app went on showing
   * recording as enabled. A retry every ten minutes costs one spawn per ten
   * minutes and recovers by itself; the log says which cadence it is on.
   *
   * ponytail: two fixed intervals, not exponential backoff — the slow one is
   * already cheap enough to run indefinitely.
   */
  private scheduleRestart(lifetimeMs: number, producedMedia: boolean): void {
    if (!this.active)
      return
    // A pending retry is REPLACED, never shadowed. HomeKit re-delivers the same
    // `Active = true` on a `CameraOperatingMode` write, so a start can run — and
    // fail — while an earlier retry is still pending; assigning over the field
    // would leave that earlier timer with nothing holding it, and `stopEncoder`
    // and disposal would then clear only the newer one. The orphan later fires
    // for an accessory HomeKit may no longer know about and fetches a stream URL
    // for it. `unref()` keeps it from holding the process open, so what is at
    // stake is a stray fetch and a retained delegate, not a hang.
    clearTimeout(this.restartTimer)
    this.failures = (lifetimeMs >= HEALTHY_RUN_MS && producedMedia) ? 0 : this.failures + 1
    const slow = this.failures > MAX_RESTARTS
    // Once, on the transition: this is the line that tells a user looking at the
    // log that recording is down and no longer retrying quickly.
    if (this.failures === MAX_RESTARTS + 1)
      this.options.log.warn(`The recording encoder for "${this.options.label}" has failed ${MAX_RESTARTS} times in a row. Still retrying, but only every ${SLOW_RESTART_DELAY_MS / 60_000} minutes now.`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      void this.startEncoder()
    }, slow ? SLOW_RESTART_DELAY_MS : RESTART_DELAY_MS)
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
   *
   * What this does NOT do is close open streams, and the guarantee that covers
   * that is narrower than it looks. Across a process boundary it is `teardown()`
   * that closes them, on the exit — by the time a new process emits its init
   * there are no open streams left. Within ONE process a second init would leave
   * an open stream holding the old init while receiving fragments encoded against
   * the new one, and nothing here prevents it: it is merely unreachable, because
   * `-movflags frag_keyframe+empty_moov` emits exactly one `ftyp+moov` per ffmpeg
   * run. If that ever stops being true, this needs the teardown treatment too.
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
      // Measured from where THIS clip started, not from zero. The pre-roll is
      // queued deliberately and is not the consumer being slow, so an absolute
      // bound made the two constants collide: a controller negotiating a long
      // `prebufferLength` opened the queue at or near PREBUFFER_FRAGMENTS, and
      // the first live fragment then tripped this guard and ended the clip with
      // a "HomeKit is behind" warning naming a consumer that had not fallen
      // behind at all.
      if (state.queue.length >= state.limit) {
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
      // Nothing decodable to send: no init segment means no clip, and yielding a
      // fragment without one would be worse than nothing.
      //
      // But an EMPTY generator is a contract violation, not an empty clip.
      // hap-nodejs's `_startStreaming` tracks `lastFragmentWasMarkedLast` and,
      // on a generator that returns without it, logs "Delegate finished
      // streaming ... without setting RecordingPacket.isLast. Can't notify
      // Controller about endOfStream!" — an unredacted console.warn from a
      // library, per request, for a state this plugin reaches routinely at
      // startup and across every encoder restart. It recovers, but only via the
      // 12 s `kickOffCloseTimeout` force-close.
      //
      // A zero-length final packet is the honest empty clip AND satisfies the
      // contract: hap-nodejs's chunk loop is `while (offset < fragment.length)`,
      // so nothing at all goes on the wire, `isLast` is recorded, and the stream
      // ends without the warning.
      this.options.log.warn(`Cannot record "${this.options.label}": the encoder has not produced an init segment yet.`)
      return (async function* () {
        yield { data: EMPTY_PACKET, isLast: true }
      })()
    }
    // Only as much pre-roll as HomeKit negotiated. The ring HOLDS 16 fragments
    // as headroom — a fragment can run long when a keyframe arrives late — but
    // sending all of them means handing over ~64 s of video at the head of a
    // clip whose `prebufferLength` promised 4 s. Observed on real hardware: the
    // controller took the 16 prebuffered fragments and closed the stream in the
    // same second, before a single live fragment.
    const queue = snapshot.fragments.slice(-this.prebufferFragments())
    const state: StreamState = { closed: false, queue, limit: queue.length + PREBUFFER_FRAGMENTS }
    this.streams.set(streamId, state)
    this.options.log.info(`Recording started for "${this.options.label}" (${state.queue.length} of ${snapshot.fragments.length} prebuffered fragments).`)
    return this.streamPackets(streamId, state, snapshot.init)
  }

  /**
   * How many prebuffered fragments a clip may open with, from what HomeKit
   * negotiated rather than from what the ring happens to be holding.
   *
   * `prebufferLength` is a promise made in `recordingOptions` — 4000 ms — and
   * a clip that opens with sixteen 4 s fragments breaks it by a factor of
   * sixteen. At least one, always: a clip with no pre-roll at all would start
   * at the moment of motion, which is the entire thing the prebuffer exists to
   * prevent.
   */
  private prebufferFragments(): number {
    // `??` is not enough: it passes 0 and NaN straight through, and BOTH make
    // this function silently restore the very bug it exists to fix. A
    // `fragmentLength` of 0 divides to Infinity, and NaN makes `slice(-NaN)`
    // equal `slice(0)` — either way the whole 16-fragment ring goes out again.
    // The configuration comes off the wire from a controller, so it is not this
    // plugin's to trust.
    const positive = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
    const wanted = positive(this.config?.prebufferLength) ?? DEFAULT_FRAGMENT_MS
    const fragmentMs = positive(this.config?.mediaContainerConfiguration.fragmentLength) ?? DEFAULT_FRAGMENT_MS
    // Capped at the ring's own depth: asking for more pre-roll than is held is
    // not an error, it just means "all of it".
    return Math.min(PREBUFFER_FRAGMENTS, Math.max(1, Math.ceil(wanted / fragmentMs)))
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
