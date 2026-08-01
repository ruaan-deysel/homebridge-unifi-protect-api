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

export function chooseEncoder(hwaccels: string, encoders: string): Omit<FfmpegCapabilities, 'path'> {
  if (hasHwaccel(hwaccels, 'qsv') && hasEncoder(encoders, 'h264_qsv'))
    return { encoder: 'h264_qsv', hwaccel: 'qsv' }
  if (hasHwaccel(hwaccels, 'vaapi') && hasEncoder(encoders, 'h264_vaapi'))
    return { encoder: 'h264_vaapi', hwaccel: 'vaapi' }
  return { encoder: 'libx264' }
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
    let caps: Omit<FfmpegCapabilities, 'path'>
    try {
      const [hwaccels, encoders] = await Promise.all([
        run(path, ['-hide_banner', '-hwaccels']),
        run(path, ['-hide_banner', '-encoders']),
      ])
      caps = chooseEncoder(hwaccels, encoders)
    }
    catch (error) {
      options.log.debug(`ffmpeg at ${path} is not usable: ${errorMessage(error)}`)
      continue
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
 * ffmpeg echoes its full command line on failure, and our command line contains
 * an RTSPS URL carrying an auth token. Redaction happens BEFORE anything is
 * logged — filtering afterwards means the secret has already been formatted into
 * a string somebody may hold a reference to.
 */
export function redactStreamUrls(text: string): string {
  return text.replace(/rtsps?:\/\/\S+/gi, '<stream-url-redacted>')
}

export type SpawnFn = (command: string, args: string[]) => ChildProcess

interface FfmpegProcessOptions {
  path: string
  args: string[]
  log: { warn: (m: string) => void }
  spawn?: SpawnFn
  /** Called once when the process ends, however it ends. */
  onExit?: () => void
}

/** Spawns, tracks and kills a single ffmpeg process. */
export class FfmpegProcess {
  private static active = 0

  /** Number of ffmpeg processes currently running, across all instances. */
  static get activeCount(): number {
    return FfmpegProcess.active
  }

  private child?: ChildProcess
  private stderr = ''
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

    child.stderr?.on('data', (chunk: Buffer) => {
      // Redact BEFORE appending/truncating: truncating first can cut the
      // `rtsps://` scheme off a token-bearing URL, and a schemeless remainder
      // no longer matches redactStreamUrls, leaving the token to be logged.
      // Bounded to 4000 chars: a failing ffmpeg can produce megabytes, and this
      // is only ever used to explain a failure.
      this.stderr = `${this.stderr}${redactStreamUrls(chunk.toString())}`.slice(-4000)
    })

    child.on('close', (code: number | null) => {
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

  stop(): void {
    if (this.killed || !this.child)
      return
    // Only treat the process as stopped once the signal was actually
    // delivered — a failed kill() must not make `running` lie, and must not
    // stop a future stop() call from retrying.
    if (this.child.kill('SIGKILL'))
      this.killed = true
  }
}
