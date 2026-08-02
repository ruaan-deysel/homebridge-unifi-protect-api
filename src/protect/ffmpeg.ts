import type { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'
import { execFile, spawn as nodeSpawn } from 'node:child_process'
import { promisify } from 'node:util'
import { errorMessage } from './errors.js'

const execFileAsync = promisify(execFile)

/** Candidate binaries, best-known-hardware first. */
export const FFMPEG_CANDIDATES = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg']

export interface FfmpegCapabilities {
  path: string
  encoder: 'h264_qsv' | 'h264_vaapi' | 'libx264'
  hwaccel?: 'qsv' | 'vaapi'
}

export type RunFfmpeg = (path: string, args: string[]) => Promise<string>

export const runFfmpeg: RunFfmpeg = async (path, args) => {
  const { stdout } = await execFileAsync(path, args, { timeout: 10_000 })
  return stdout
}

/**
 * An encoder line looks like ` V..... h264_qsv  H.264 / AVC ... `. Anchoring on
 * a word boundary matters: the same list contains `hevc_qsv` and `mjpeg_qsv`,
 * and a substring match on "qsv" would select a codec HomeKit cannot decode.
 */
export function hasEncoder(encoders: string, name: string): boolean {
  return new RegExp(`^\\s*\\S+\\s+${name}\\b`, 'm').test(encoders)
}

function hasHwaccel(hwaccels: string, name: string): boolean {
  return new RegExp(`^\\s*${name}\\s*$`, 'm').test(hwaccels)
}

/**
 * Every encoder this build claims, best first, always ending in libx264.
 *
 * A LIST and not a single pick, because claiming is not working: measured on
 * the reference console (i7-8700K / UHD 630), `/usr/bin/ffmpeg` lists h264_qsv
 * and h264_vaapi, and QSV fails outright — `Device creation failed: -1313558101`
 * — while VAAPI encodes fine. Returning only the first preference meant a failed
 * QSV trial fell straight to software on a host with a perfectly good hardware
 * encoder: ~2.5 cores per stream instead of ~0.09, and a cap of two instead of six.
 * Software is the last resort, never the second.
 */
export function encoderCandidates(hwaccels: string, encoders: string): Omit<FfmpegCapabilities, 'path'>[] {
  const candidates: Omit<FfmpegCapabilities, 'path'>[] = []
  if (hasHwaccel(hwaccels, 'qsv') && hasEncoder(encoders, 'h264_qsv'))
    candidates.push({ encoder: 'h264_qsv', hwaccel: 'qsv' })
  if (hasHwaccel(hwaccels, 'vaapi') && hasEncoder(encoders, 'h264_vaapi'))
    candidates.push({ encoder: 'h264_vaapi', hwaccel: 'vaapi' })
  // Always present, always last: it needs no device and cannot fail its trial.
  candidates.push({ encoder: 'libx264' })
  return candidates
}

/**
 * A ~2-frame encode of a blank source. Being *listed* by `-encoders` says only
 * that the build was compiled with the encoder — not that this container can
 * open `/dev/dri`, that the driver is installed, or that the GPU is not already
 * exhausted. Committing to VAAPI on a listing alone makes every live view fail
 * at the moment a user presses play, with no fallback.
 */
export function viabilityArgs(caps: Omit<FfmpegCapabilities, 'path'>): string[] {
  const source = ['-hide_banner', '-f', 'lavfi', '-i', 'nullsrc=s=64x64:d=0.1']
  if (caps.hwaccel === 'vaapi') {
    return [...source, '-vaapi_device', '/dev/dri/renderD128', '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-f', 'null', '-']
  }
  return [...source, '-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw', '-vf', 'format=nv12,hwupload=extra_hw_frames=64', '-c:v', 'h264_qsv', '-f', 'null', '-']
}

interface ProbeOptions {
  log: { info: (m: string) => void, warn: (m: string) => void, debug: (m: string) => void }
  run?: RunFfmpeg
  candidates?: string[]
  configuredPath?: string
}

export async function probeFfmpeg(options: ProbeOptions): Promise<FfmpegCapabilities> {
  const run = options.run ?? runFfmpeg
  const paths = options.configuredPath ? [options.configuredPath] : (options.candidates ?? FFMPEG_CANDIDATES)

  let fallback: FfmpegCapabilities | undefined
  for (const path of paths) {
    let candidates: Omit<FfmpegCapabilities, 'path'>[]
    try {
      const [hwaccels, encoders] = await Promise.all([
        run(path, ['-hide_banner', '-hwaccels']),
        run(path, ['-hide_banner', '-encoders']),
      ])
      candidates = encoderCandidates(hwaccels, encoders)
    }
    catch (error) {
      options.log.debug(`ffmpeg at ${path} is not usable: ${errorMessage(error)}`)
      continue
    }

    // Trial each in turn and take the first that ACTUALLY encodes. libx264 is
    // last and needs no device, so `caps` is always assigned.
    let caps = candidates.at(-1)!
    for (const candidate of candidates) {
      if (candidate.encoder === 'libx264')
        break
      try {
        await run(path, viabilityArgs(candidate))
        caps = candidate
        break
      }
      catch (error) {
        // Listed but not usable — no /dev/dri in the container, no driver, or
        // the GPU is busy. Try the next hardware encoder before giving up on
        // hardware altogether.
        options.log.debug(`ffmpeg at ${path} lists ${candidate.encoder} but cannot use it: ${errorMessage(error)}`)
      }
    }

    if (caps.encoder !== 'libx264') {
      options.log.info(`Using ffmpeg at ${path} with hardware encoding (${caps.encoder}).`)
      return { path, ...caps }
    }
    // Keep looking: a later candidate may have hardware support. `/usr/local/bin`
    // precedes `/usr/bin` on PATH in the Homebridge image, and the binary it
    // shadows is the one WITHOUT Intel support.
    fallback ??= { path, ...caps }
  }

  if (!fallback) {
    throw new Error(options.configuredPath
      ? `Configured ffmpeg path "${options.configuredPath}" is not usable. Check the ffmpegPath plugin setting.`
      : 'Found no usable ffmpeg. Set ffmpegPath in the plugin settings.')
  }

  // warn, not info: a silent fallback to software costs roughly 27x the CPU, and
  // this line is the user's only signal that hardware acceleration isn't reaching
  // the container.
  options.log.warn(`Using ffmpeg at ${fallback.path} with software encoding (libx264). Live view will be CPU-expensive; see the README on enabling hardware transcoding.`)
  return fallback
}

/**
 * Stream URLs AND SRTP keys. ffmpeg echoes its full command line on failure,
 * and our command line contains both an RTSPS URL carrying an auth token and,
 * for talkback, a `-srtp_out_params <key|salt>` — a per-session secret.
 * Redaction happens BEFORE anything is logged — filtering afterwards means the
 * secret has already been formatted into a string somebody may hold a
 * reference to.
 */
export function redactStreamUrls(text: string): string {
  return text
    .replace(/rtsps?:\/\/\S+/gi, '<stream-url-redacted>')
    .replace(/(-srtp_(?:in|out)_params\s+)\S+/gi, '$1<srtp-key-redacted>')
}

/** How much redacted stderr is kept to explain a failure. */
const STDERR_LIMIT = 4000
/**
 * A whitespace-free run longer than this is not diagnostics, and holding it
 * unbounded waiting for a terminator would be the memory leak. Dropped rather
 * than redacted-and-kept: dropping cannot leak, redacting a fragment can.
 */
const TOKEN_LIMIT = 4096

/**
 * Splits `text` into the part that is safe to redact now and the part that may
 * still be growing. A stream URL is one whitespace-delimited token, and a `data`
 * event can land anywhere inside it — including between `rtsps:` and the token —
 * so redaction must never run on a trailing fragment. `\S*$` matches exactly the
 * unterminated tail, and `search` returns where it starts.
 *
 * A tail past `tokenLimit` is DROPPED, not returned: holding it until a
 * terminator that may never come is the unbounded buffer, and a whitespace-free
 * run that long is not diagnostics anyway. Dropping cannot leak; redacting a
 * fragment of it can.
 */
export function splitOnLastToken(text: string, tokenLimit = TOKEN_LIMIT): { complete: string, pending: string } {
  const boundary = text.search(/\S*$/)
  const pending = text.slice(boundary)
  return { complete: text.slice(0, boundary), pending: pending.length > tokenLimit ? '' : pending }
}

export type SpawnFn = (command: string, args: string[]) => ChildProcess

interface FfmpegProcessOptions {
  path: string
  args: string[]
  log: { warn: (m: string) => void }
  spawn?: SpawnFn
  /** Called once when the process ends, however it ends. */
  onExit?: () => void
  /**
   * Written to the child's stdin at spawn, then closed. The talkback encoder
   * reads an SDP this way: raw RTP carries no format metadata, so ffmpeg cannot
   * decode an SRTP stream without one.
   */
  stdin?: string
}

/** Spawns, tracks and kills a single ffmpeg process. */
export class FfmpegProcess {
  private static active = 0

  /** Number of ffmpeg processes currently running, across all instances. */
  static get activeCount(): number {
    return FfmpegProcess.active
  }

  private child?: ChildProcess
  /** Already redacted, always. Nothing unredacted is ever appended here. */
  private stderr = ''
  /** The unterminated trailing token, held back until it is complete. */
  private pendingStderr = ''
  /** Set once a kill signal has actually been delivered; guards stop()'s re-entry. */
  private killed = false
  /** Set once the process has actually exited; guards the active count and onExit. */
  private ended = false

  constructor(private readonly options: FfmpegProcessOptions) {}

  get running(): boolean {
    return this.child !== undefined && !this.ended
  }

  start(): void {
    if (this.child)
      throw new Error('FfmpegProcess.start() called twice on the same instance')

    const spawn = this.options.spawn ?? (nodeSpawn as SpawnFn)
    const child = spawn(this.options.path, this.options.args)
    this.child = child
    FfmpegProcess.active++

    child.stderr?.on('data', (chunk: Buffer) => this.absorb(chunk.toString()))

    if (this.options.stdin !== undefined) {
      // A child that has already died (or closed its own stdin) turns this
      // write into an EPIPE, delivered as an 'error' event on the stream —
      // and Node crashes the host process on an unhandled 'error' event.
      // Deliberately swallowed rather than logged: the same death is already
      // reported, with better detail (exit code, stderr tail), by the
      // 'close'/'error' handlers on the child below. Routing this into
      // finish() too would just risk winning the idempotency race and
      // burying that richer message behind a bare "stdin failed".
      child.stdin?.on('error', () => {})
      child.stdin?.write(this.options.stdin)
      child.stdin?.end()
    }

    child.on('close', (code: number | null) => {
      this.flushStderr()
      const message = (code !== null && code !== 0)
        ? `ffmpeg exited with code ${code}: ${this.stderr.trim().split('\n').slice(-3).join(' | ')}`
        : undefined
      this.finish(message)
    })

    child.on('error', (error: Error) => {
      this.finish(`ffmpeg could not start: ${redactStreamUrls(errorMessage(error))}`)
    })
  }

  /**
   * The single place stderr enters this object, and the reason redaction is
   * structural rather than per-chunk: it runs only on whole tokens, and the
   * 4000-char bound is applied to text that is ALREADY redacted, so truncation
   * can only ever cut a placeholder. Both of the earlier leaks on this path —
   * truncate-then-redact, and redact-per-chunk — are shapes this cannot take.
   */
  private absorb(text: string): void {
    const { complete, pending } = splitOnLastToken(this.pendingStderr + text)
    this.pendingStderr = pending
    if (complete !== '')
      this.stderr = `${this.stderr}${redactStreamUrls(complete)}`.slice(-STDERR_LIMIT)
  }

  /** ffmpeg's last line often has no trailing newline; it is still one token. */
  private flushStderr(): void {
    if (this.pendingStderr === '')
      return
    const tail = this.pendingStderr
    this.pendingStderr = ''
    this.stderr = `${this.stderr}${redactStreamUrls(tail)}`.slice(-STDERR_LIMIT)
  }

  /**
   * Runs exactly once however the process ends (close or error, never both):
   * releases the active slot and notifies the caller. A failed spawn emits
   * `error` and then `close`, and onExit's contract is exactly-once, same as
   * the active count.
   */
  private finish(message: string | undefined): void {
    if (this.ended)
      return
    this.ended = true
    FfmpegProcess.active--
    if (message !== undefined)
      this.options.log.warn(message)
    this.options.onExit?.()
  }

  /**
   * True when this process needs no further attention: it has exited, it was
   * never started, or the kill signal was actually delivered. FALSE means an
   * orphan — kill() failed, the process is still running, and it still holds
   * its slot in the host-wide cap. The caller must keep its handle and retry,
   * because nothing else can.
   */
  stop(): boolean {
    if (this.ended || this.killed || !this.child)
      return true
    // Only treat the process as stopped once the signal was actually
    // delivered — a failed kill() must not make `running` lie, and must not
    // stop a future stop() call from retrying.
    if (this.child.kill('SIGKILL'))
      this.killed = true
    return this.killed
  }
}
