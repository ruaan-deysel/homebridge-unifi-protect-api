import type { PrepareStreamRequest, PrepareStreamResponse, SourceResponse, StreamingRequest } from 'homebridge'
import type { ChildProcess } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { inspect } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildFfmpegArgs, defaultMaxStreams, StreamingDelegate } from '../src/accessories/streaming.js'
import { FfmpegProcess } from '../src/protect/ffmpeg.js'

const CAPS_HW = { path: '/usr/bin/ffmpeg', encoder: 'h264_vaapi' as const, hwaccel: 'vaapi' as const }
const CAPS_SW = { path: '/usr/local/bin/ffmpeg', encoder: 'libx264' as const }
const URL = 'rtsps://192.0.2.1:7441/live?token=SENTINEL'

describe('defaultMaxStreams', () => {
  // Measured 2026-08-01: 20s of 2688x1512 costs 1.79s CPU on VAAPI, 49.1s on
  // libx264 — about 27x. A flat cap is wrong in both directions.
  it('allows more concurrent streams on hardware than software', () => {
    expect(defaultMaxStreams(CAPS_HW)).toBe(6)
    expect(defaultMaxStreams(CAPS_SW)).toBe(2)
  })
})

describe('buildFfmpegArgs', () => {
  const base = {
    url: URL,
    width: 1280,
    height: 720,
    fps: 30,
    bitrate: 3000,
    audio: false,
    address: '192.0.2.9',
    videoPort: 5000,
    videoSsrc: 1,
    videoKey: Buffer.alloc(30),
  }

  it('uses hardware flags when the probe found hardware', () => {
    const args = buildFfmpegArgs(CAPS_HW, base)
    expect(args).toContain('-hwaccel')
    expect(args).toContain('vaapi')
    expect(args.join(' ')).toContain('-c:v h264_vaapi')
  })

  it('uses no hardware flags on the software path', () => {
    const args = buildFfmpegArgs(CAPS_SW, base)
    expect(args).not.toContain('-hwaccel')
    expect(args.join(' ')).toContain('-c:v libx264')
  })

  it('omits audio unless the camera opts in', () => {
    expect(buildFfmpegArgs(CAPS_HW, base)).toContain('-an')
    expect(buildFfmpegArgs(CAPS_HW, { ...base, audio: true })).not.toContain('-an')
  })

  it('always reads rtsp over tcp', () => {
    expect(buildFfmpegArgs(CAPS_HW, base).join(' ')).toContain('-rtsp_transport tcp')
  })

  it('brackets an ipv6 destination', () => {
    const args = buildFfmpegArgs(CAPS_HW, { ...base, address: 'fd00::1' })
    expect(args.at(-1)).toContain('srtp://[fd00::1]:5000')
  })
})

/** A stand-in child that only does what FfmpegProcess touches: stderr, close, kill. */
function fakeChild(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter, kill: () => boolean }
  child.stderr = new EventEmitter()
  // The real child emits `close` after a kill; without it the process-wide
  // active count would never be released.
  child.kill = () => child.emit('close', 0)
  return child as unknown as ChildProcess
}

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

interface DelegateOverrides {
  caps?: typeof CAPS_HW | typeof CAPS_SW
  getSnapshot?: () => Promise<Buffer>
  url?: () => Promise<string>
  audio?: boolean
  quality?: 'auto' | 'low' | 'medium' | 'high'
}

const jpeg = Buffer.from('jpeg-bytes')

/** The API key hides in `cause`, exactly where util.inspect finds it. */
async function failingSnapshot(): Promise<Buffer> {
  throw Object.assign(new Error('403'), { cause: { apiKey: 'SECRET-KEY' } })
}

async function failingUrl(): Promise<string> {
  throw new Error('console said no')
}

function makeDelegate(overrides: DelegateOverrides = {}) {
  const log = makeLog()
  const getSnapshot = vi.fn(overrides.getSnapshot ?? (async () => jpeg))
  const get = vi.fn(overrides.url ?? (async () => URL))
  const spawn = vi.fn(() => fakeChild())
  const delegate = new StreamingDelegate({
    deviceId: 'cam1',
    label: 'Driveway',
    log,
    client: { getSnapshot } as never,
    urls: { get, clear: vi.fn() } as never,
    caps: overrides.caps ?? CAPS_HW,
    settings: () => ({ quality: overrides.quality ?? 'auto', audio: overrides.audio ?? false }),
    spawn,
  })
  return { delegate, getSnapshot, get, spawn, log }
}

const RTP = { address: '192.0.2.9', videoPort: 5000, videoSsrc: 7, videoKey: Buffer.alloc(30), localPort: 5001 }
const REQUEST = { width: 1280, height: 720, fps: 30, bitrate: 3000 }

afterEach(() => {
  // A leaked count would silently change every later cap assertion.
  expect(FfmpegProcess.activeCount).toBe(0)
})

describe('streamingDelegate snapshots', () => {
  it('serves the protect jpeg without spawning ffmpeg', async () => {
    const { delegate, getSnapshot, spawn } = makeDelegate()
    const out = await delegate.snapshot()
    expect(out).toBe(jpeg)
    expect(getSnapshot).toHaveBeenCalledWith('cam1', expect.anything())
    expect(spawn).not.toHaveBeenCalled()
  })

  it('caches a snapshot so repeated polls hit the console once', async () => {
    const { delegate, getSnapshot } = makeDelegate()
    await delegate.snapshot()
    await delegate.snapshot()
    expect(getSnapshot).toHaveBeenCalledTimes(1)
  })

  it('surfaces a failure without leaking the api key', async () => {
    const { delegate, log } = makeDelegate({ getSnapshot: failingSnapshot })
    await expect(delegate.snapshot()).rejects.toThrow()
    const logged = JSON.stringify(log.warn.mock.calls)
    expect(logged).not.toContain('SECRET-KEY')
  })

  it('hands hap an error whose inspection cannot reach the api key', async () => {
    const { delegate } = makeDelegate({ getSnapshot: failingSnapshot })
    const error = await new Promise<unknown>((resolve) => {
      delegate.handleSnapshotRequest({ width: 1280, height: 720 }, resolve)
    })
    // `log.error(err)` is util.inspect, which walks `cause`.
    expect(inspect(error, { depth: 5 })).not.toContain('SECRET-KEY')
  })

  it('answers a snapshot request through the hap callback', async () => {
    const { delegate } = makeDelegate()
    const buffer = await new Promise((resolve) => {
      delegate.handleSnapshotRequest({ width: 1280, height: 720 }, (_error, out) => resolve(out))
    })
    expect(buffer).toBe(jpeg)
  })
})

describe('streamingDelegate sessions', () => {
  it('selects the substream from the requested resolution', async () => {
    const { delegate, get } = makeDelegate()
    await delegate.startSession('a', { ...REQUEST, width: 640, height: 360 }, RTP)
    expect(get).toHaveBeenCalledWith('cam1', 'low')
    delegate.stopAll()

    const second = makeDelegate()
    await second.delegate.startSession('a', { ...REQUEST, width: 2688, height: 1512 }, RTP)
    expect(second.get).toHaveBeenCalledWith('cam1', 'high')
    second.delegate.stopAll()
  })

  it('passes the stream url to ffmpeg and never logs it', async () => {
    const { delegate, spawn, log } = makeDelegate()
    await delegate.startSession('a', REQUEST, RTP)

    const [path, args] = spawn.mock.calls[0] as unknown as [string, string[]]
    expect(path).toBe(CAPS_HW.path)
    expect(args).toContain(URL)

    // The URL is a credential. Nothing on any log level may contain it.
    const everything = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.debug.mock.calls, log.error.mock.calls])
    expect(everything).not.toContain('SENTINEL')
    expect(everything).not.toContain('rtsps://')
    delegate.stopAll()
  })

  it('refuses to spawn when the url cannot be fetched', async () => {
    const { delegate, spawn, log } = makeDelegate({ url: failingUrl })
    expect(await delegate.startSession('a', REQUEST, RTP)).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalled()
  })

  it('stops a session, killing the process and freeing the slot', async () => {
    const { delegate } = makeDelegate()
    await delegate.startSession('a', REQUEST, RTP)
    expect(delegate.activeCount).toBe(1)
    expect(FfmpegProcess.activeCount).toBe(1)
    delegate.stopSession('a')
    expect(delegate.activeCount).toBe(0)
    expect(FfmpegProcess.activeCount).toBe(0)
  })

  it('enforces the cap host-wide, so a second camera cannot exceed it', async () => {
    // Two cameras, two delegates, one host. The cap belongs to the host's CPU.
    const first = makeDelegate({ caps: CAPS_SW })
    const second = makeDelegate({ caps: CAPS_SW })

    expect(await first.delegate.startSession('a', REQUEST, RTP)).toBe(true)
    expect(await first.delegate.startSession('b', REQUEST, RTP)).toBe(true)

    // The second delegate has ZERO sessions of its own — only a per-delegate
    // cap would let this through.
    expect(second.delegate.activeCount).toBe(0)
    expect(await second.delegate.startSession('c', REQUEST, RTP)).toBe(false)
    expect(second.spawn).not.toHaveBeenCalled()
    expect(second.log.warn.mock.calls.join(' ')).toContain('maximum 2')

    first.delegate.stopAll()
    expect(await second.delegate.startSession('c', REQUEST, RTP)).toBe(true)
    second.delegate.stopAll()
  })

  it('omits audio unless the camera opts in', async () => {
    const off = makeDelegate()
    await off.delegate.startSession('a', REQUEST, RTP)
    expect((off.spawn.mock.calls[0] as unknown as [string, string[]])[1]).toContain('-an')
    off.delegate.stopAll()

    const on = makeDelegate({ audio: true })
    await on.delegate.startSession('a', REQUEST, RTP)
    expect((on.spawn.mock.calls[0] as unknown as [string, string[]])[1]).not.toContain('-an')
    on.delegate.stopAll()
  })
})

function prepareRequest(): PrepareStreamRequest {
  return {
    sessionID: 'session-1',
    sourceAddress: '192.0.2.20',
    targetAddress: '192.0.2.9',
    addressVersion: 'ipv4',
    video: { port: 5000, srtpCryptoSuite: 0, srtp_key: Buffer.alloc(16, 1), srtp_salt: Buffer.alloc(14, 2) },
    audio: { port: 5002, srtpCryptoSuite: 0, srtp_key: Buffer.alloc(16, 3), srtp_salt: Buffer.alloc(14, 4) },
  }
}

function startRequest(): StreamingRequest {
  return {
    sessionID: 'session-1',
    type: 'start',
    video: { width: 1280, height: 720, fps: 30, max_bit_rate: 802, ssrc: 1, pt: 99, mtu: 1378, rtcp_interval: 0.5 },
    audio: {},
  } as unknown as StreamingRequest
}

describe('streamingDelegate hap wiring', () => {
  it('prepareStream returns a port, an ssrc and the srtp material homekit sent', async () => {
    const { delegate } = makeDelegate()
    const response = await new Promise<PrepareStreamResponse>((resolve, reject) => {
      delegate.prepareStream(prepareRequest(), (error, r) => (r ? resolve(r) : reject(error)))
    })
    const video = response.video as SourceResponse
    expect(video.port).toBeGreaterThan(0)
    expect(video.ssrc).toBeGreaterThan(0)
    expect(video.srtp_key).toEqual(Buffer.alloc(16, 1))
    expect(video.srtp_salt).toEqual(Buffer.alloc(14, 2))
  })

  it('start uses the prepared session, and stop kills it', async () => {
    const { delegate, spawn } = makeDelegate()
    await new Promise<void>((resolve, reject) => {
      delegate.prepareStream(prepareRequest(), error => (error ? reject(error) : resolve()))
    })
    await new Promise<void>((resolve, reject) => {
      delegate.handleStreamRequest(startRequest(), error => (error ? reject(error) : resolve()))
    })
    const args = (spawn.mock.calls[0] as unknown as [string, string[]])[1]
    // The destination is the address and port HomeKit asked for, not a default.
    expect(args.at(-1)).toContain('srtp://192.0.2.9:5000')
    expect(delegate.activeCount).toBe(1)

    delegate.handleStreamRequest({ sessionID: 'session-1', type: 'stop' } as unknown as StreamingRequest, vi.fn())
    expect(delegate.activeCount).toBe(0)
  })

  it('errors instead of spawning when a start arrives with no prepared session', async () => {
    const { delegate, spawn } = makeDelegate()
    const error = await new Promise(resolve => delegate.handleStreamRequest(startRequest(), resolve))
    expect(error).toBeInstanceOf(Error)
    expect(spawn).not.toHaveBeenCalled()
  })
})
