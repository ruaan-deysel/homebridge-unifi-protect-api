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
function hasEncoder(encoders: string, name: string): boolean {
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
  log: { info: (m: string) => void, debug: (m: string) => void }
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

  if (!fallback)
    throw new Error('Found no usable ffmpeg. Set ffmpegPath in the plugin settings.')

  options.log.info(`Using ffmpeg at ${fallback.path} with software encoding (libx264). Live view will be CPU-expensive; see the README on enabling hardware transcoding.`)
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
  log: { warn: (m: string) => void, debug: (m: string) => void }
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
  private stopped = false
  private ended = false

  constructor(private readonly options: FfmpegProcessOptions) {}

  get running(): boolean {
    return this.child !== undefined && !this.stopped
  }

  start(): void {
    const spawn = this.options.spawn ?? (nodeSpawn as SpawnFn)
    const child = spawn(this.options.path, this.options.args)
    this.child = child
    FfmpegProcess.active++

    child.stderr?.on('data', (chunk: Buffer) => {
      // Bounded: a failing ffmpeg can produce megabytes, and this is only ever
      // used to explain a failure.
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-4000)
    })

    child.on('close', (code: number | null) => {
      this.stopped = true
      this.release()
      if (code !== null && code !== 0)
        this.options.log.warn(`ffmpeg exited with code ${code}: ${redactStreamUrls(this.stderr).trim().split('\n').slice(-3).join(' | ')}`)
      this.options.onExit?.()
    })

    child.on('error', (error: Error) => {
      this.stopped = true
      this.release()
      this.options.log.warn(`ffmpeg could not start: ${redactStreamUrls(errorMessage(error))}`)
      this.options.onExit?.()
    })
  }

  /** Decrements the active count exactly once, however the process ended. */
  private release(): void {
    if (this.ended)
      return
    this.ended = true
    FfmpegProcess.active--
  }

  stop(): void {
    if (this.stopped || !this.child)
      return
    this.stopped = true
    this.child.kill('SIGKILL')
  }
}
