import { execFile } from 'node:child_process'
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
