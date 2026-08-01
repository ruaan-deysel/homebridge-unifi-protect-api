import type { PrepareStreamRequest, PrepareStreamResponse, SourceResponse, StreamingRequest } from 'homebridge'
import type { ChildProcess } from 'node:child_process'
import type { StreamArgs } from '../src/accessories/streaming.js'
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { inspect } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { audioStreamingCodec, buildFfmpegArgs, chooseAudioCodec, defaultMaxStreams, randomSsrc, StreamingDelegate } from '../src/accessories/streaming.js'
import { FfmpegProcess } from '../src/protect/ffmpeg.js'

const CAPS_HW = { path: '/usr/bin/ffmpeg', encoder: 'h264_vaapi' as const, hwaccel: 'vaapi' as const }
const CAPS_SW = { path: '/usr/local/bin/ffmpeg', encoder: 'libx264' as const }
const URL = 'rtsps://192.0.2.1:7441/live?token=SENTINEL'

/**
 * An `-encoders` listing shaped like the real one. The two builds in the target
 * container are mutually exclusive: /usr/bin/ffmpeg has libopus and hardware
 * video but no libfdk_aac; the bundled static build is the other way round.
 */
function encoderList(has: { opus?: boolean, aacEld?: boolean } = {}): string {
  return [
    ' V..... h264_vaapi           H.264/AVC (VAAPI)',
    ' V..... libx264              libx264 H.264 / AVC',
    // Both names appear in a DESCRIPTION here, not in the encoder column. A bare
    // substring test would call this a hit and hand ffmpeg an encoder it lacks.
    ' A..... aac                  AAC (Advanced Audio Coding) (alternatives: libfdk_aac libopus)',
    ...(has.aacEld ? [' A..... libfdk_aac           Fraunhofer FDK AAC'] : []),
    ...(has.opus ? [' A..... libopus              libopus Opus'] : []),
  ].join('\n')
}

describe('defaultMaxStreams', () => {
  // Measured 2026-08-01: 20s of 2688x1512 costs 1.79s CPU on VAAPI, 49.1s on
  // libx264 — about 27x. A flat cap is wrong in both directions.
  it('allows more concurrent streams on hardware than software', () => {
    expect(defaultMaxStreams(CAPS_HW)).toBe(6)
    expect(defaultMaxStreams(CAPS_SW)).toBe(2)
  })
})

describe('randomSsrc', () => {
  const INT32_MAX = 2_147_483_647

  // HomeKit and ffmpeg's `-ssrc` both want a positive SIGNED 32-bit value.
  // `random() * 0xFFFFFFFF + 1` overshoots it, so a fraction of streams got a
  // malformed SSRC and simply never loaded — with nothing in any log.
  it('stays inside positive signed 32-bit range at the top of Math.random', () => {
    // The largest double below 1, which is what Math.random can actually return.
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.9999999999999999)
    expect(randomSsrc()).toBeLessThanOrEqual(INT32_MAX)
    spy.mockRestore()
  })

  it('is never zero at the bottom of Math.random', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(randomSsrc()).toBeGreaterThan(0)
    spy.mockRestore()
  })

  it('produces values across the range, not one constant', () => {
    const seen = new Set(Array.from({ length: 50 }, () => randomSsrc()))
    expect(seen.size).toBeGreaterThan(40)
    for (const ssrc of seen) {
      expect(ssrc).toBeGreaterThan(0)
      expect(ssrc).toBeLessThanOrEqual(INT32_MAX)
    }
  })
})

describe('buildFfmpegArgs', () => {
  const base: StreamArgs = {
    url: URL,
    bitrate: 3000,
    address: '192.0.2.9',
    video: { port: 5000, ssrc: 1, key: Buffer.alloc(30), payloadType: 99, localPort: 5001 },
  }
  const audioTarget = { port: 5002, ssrc: 2, key: Buffer.alloc(30, 7), payloadType: 110, sampleRate: 24, bitrate: 24, localPort: 5003 }
  const withAudio: StreamArgs = { ...base, audio: { ...audioTarget, codec: 'opus' } }
  const withAacEld: StreamArgs = { ...base, audio: { ...audioTarget, codec: 'aac-eld' } }

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

  it('always reads rtsp over tcp', () => {
    expect(buildFfmpegArgs(CAPS_HW, base).join(' ')).toContain('-rtsp_transport tcp')
  })

  it('brackets an ipv6 destination', () => {
    const args = buildFfmpegArgs(CAPS_HW, { ...base, address: 'fd00::1' })
    expect(args.at(-1)).toContain('srtp://[fd00::1]:5000')
  })

  it('uses the payload types homekit asked for, not a hardcoded 99', () => {
    const args = buildFfmpegArgs(CAPS_HW, {
      ...withAudio,
      video: { ...base.video, payloadType: 97 },
    })
    expect(args.join(' ')).toContain('-payload_type 97')
    expect(args.join(' ')).toContain('-payload_type 110')
    expect(args).not.toContain('99')
  })

  describe('without audio', () => {
    const args = buildFfmpegArgs(CAPS_HW, base)

    it('drops the input audio track and emits exactly one output', () => {
      expect(args).toContain('-an')
      expect(args.filter(a => a === '-f')).toHaveLength(1)
      expect(args.filter(a => a.startsWith('srtp://'))).toHaveLength(1)
      expect(args).not.toContain('-c:a')
    })
  })

  describe('with audio', () => {
    const args = buildFfmpegArgs(CAPS_HW, withAudio)
    const joined = args.join(' ')

    it('emits a second rtp output aimed at homekit audio port', () => {
      // `-f rtp` carries one stream, so audio MUST be its own output.
      expect(args.filter(a => a === '-f')).toHaveLength(2)
      const destinations = args.filter(a => a.startsWith('srtp://'))
      expect(destinations).toEqual([
        'srtp://192.0.2.9:5000?rtcpport=5000&localrtcpport=5001&pkt_size=1316',
        'srtp://192.0.2.9:5002?rtcpport=5002&localrtcpport=5003&pkt_size=188',
      ])
    })

    it('encodes opus low-delay at the rate homekit asked for and never mutes the input', () => {
      expect(joined).toContain('-c:a libopus -application lowdelay -frame_duration 20')
      expect(joined).toContain('-ar 24k')
      expect(joined).toContain('-b:a 24k')
      expect(args).not.toContain('-an')
    })

    it('encodes aac-eld when that is the chosen codec', () => {
      const aac = buildFfmpegArgs(CAPS_HW, withAacEld).join(' ')
      expect(aac).toContain('-c:a libfdk_aac -profile:a aac_eld')
      expect(aac).not.toContain('libopus')
    })

    it('gives each output its own ssrc and srtp key', () => {
      expect(joined).toContain('-ssrc 1')
      expect(joined).toContain('-ssrc 2')
      expect(joined).toContain(Buffer.alloc(30).toString('base64'))
      expect(joined).toContain(Buffer.alloc(30, 7).toString('base64'))
    })

    it('maps the audio track optionally, so a camera with no microphone still starts', () => {
      expect(joined).toContain('-map 0:a:0?')
      expect(joined).toContain('-map 0:v:0')
    })
  })
})

describe('chooseAudioCodec', () => {
  // Measured 2026-08-01: /usr/bin/ffmpeg (the only build with VAAPI/QSV) has
  // libopus and no libfdk_aac. Preferring AAC-ELD would force a choice between
  // hardware video and any audio at all.
  it('prefers opus, so the hardware build can still carry audio', () => {
    expect(chooseAudioCodec(encoderList({ opus: true }))).toBe('opus')
    expect(chooseAudioCodec(encoderList({ opus: true, aacEld: true }))).toBe('opus')
  })

  it('falls back to aac-eld when that is all the build has', () => {
    expect(chooseAudioCodec(encoderList({ aacEld: true }))).toBe('aac-eld')
  })

  it('chooses nothing when neither encoder is present', () => {
    expect(chooseAudioCodec(encoderList())).toBeUndefined()
  })
})

describe('the advertised codec and the produced codec', () => {
  // Advertising one codec and sending another fails on the iPhone, where no unit
  // test is watching. The pairing is asserted here against a literal table.
  const expected = {
    'opus': { hapType: 'OPUS', flag: '-c:a libopus' },
    'aac-eld': { hapType: 'AAC-eld', flag: '-c:a libfdk_aac' },
  } as const

  for (const codec of ['opus', 'aac-eld'] as const) {
    it(`agree for ${codec}`, () => {
      expect(audioStreamingCodec(codec).type).toBe(expected[codec].hapType)
      const args = buildFfmpegArgs(CAPS_HW, {
        url: URL,
        bitrate: 3000,
        address: '192.0.2.9',
        video: { port: 5000, ssrc: 1, key: Buffer.alloc(30), payloadType: 99 },
        audio: { port: 5002, ssrc: 2, key: Buffer.alloc(30), payloadType: 110, sampleRate: 24, bitrate: 24, codec },
      })
      expect(args.join(' ')).toContain(expected[codec].flag)
    })
  }

  it('offers homekit the sample rates it actually asks for', () => {
    expect(audioStreamingCodec('opus').samplerate).toEqual([16, 24])
    expect(audioStreamingCodec('opus').audioChannels).toBe(1)
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
  encoders?: { opus?: boolean, aacEld?: boolean }
  run?: () => Promise<string>
  spawn?: () => ChildProcess
  quality?: 'auto' | 'low' | 'medium' | 'high'
  maxStreams?: number
}

const jpeg = Buffer.from('jpeg-bytes')

/** The API key hides in `cause`, exactly where util.inspect finds it. */
async function failingSnapshot(): Promise<Buffer> {
  throw Object.assign(new Error('403'), { cause: { apiKey: 'SECRET-KEY' } })
}

async function failingUrl(): Promise<string> {
  throw new Error('console said no')
}

async function failingProbe(): Promise<string> {
  throw new Error('ffmpeg is gone')
}

function throwingSpawn(): ChildProcess {
  throw new Error('ENOENT')
}

/**
 * A child that is already gone by the time FfmpegProcess finishes wiring it up:
 * its `close` listener fires the moment it is registered. That is what a spawn
 * which dies instantly (bad arguments, killed by the OOM killer) looks like from
 * inside `start()`, and it is the only way `proc.running` is false there.
 */
function deadSpawn(): ChildProcess {
  const child = fakeChild()
  const on = child.on.bind(child)
  const patched = (event: string, handler: (...args: never[]) => void) => {
    const result = on(event as never, handler as never)
    if (event === 'close')
      (handler as (code: number) => void)(0)
    return result
  }
  child.on = patched as unknown as ChildProcess['on']
  return child
}

function makeDelegate(overrides: DelegateOverrides = {}) {
  const log = makeLog()
  const getSnapshot = vi.fn(overrides.getSnapshot ?? (async () => jpeg))
  const get = vi.fn(overrides.url ?? (async () => URL))
  const spawn = vi.fn(overrides.spawn ?? (() => fakeChild()))
  const run = vi.fn(overrides.run ?? (async () => encoderList(overrides.encoders ?? { opus: true })))
  const delegate = new StreamingDelegate({
    deviceId: 'cam1',
    label: 'Driveway',
    log,
    client: { getSnapshot } as never,
    urls: { get, clear: vi.fn() } as never,
    caps: overrides.caps ?? CAPS_HW,
    settings: () => ({ quality: overrides.quality ?? 'auto', audio: overrides.audio ?? false }),
    spawn,
    run,
    maxStreams: overrides.maxStreams,
  })
  return { delegate, getSnapshot, get, spawn, run, log }
}

const RTP = {
  address: '192.0.2.9',
  video: { port: 5000, ssrc: 7, key: Buffer.alloc(30), localPort: 5001 },
  audio: { port: 5002, ssrc: 8, key: Buffer.alloc(30, 7), localPort: 5003 },
}
const REQUEST = {
  width: 1280,
  height: 720,
  fps: 30,
  bitrate: 3000,
  videoPayloadType: 99,
  audio: { payloadType: 110, sampleRate: 16, bitrate: 24 },
}

/** The argv of the nth spawn. */
function argvOf(spawn: { mock: { calls: unknown[] } }, index = 0): string[] {
  return (spawn.mock.calls[index] as [string, string[]])[1]
}

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
    const { delegate, spawn, log } = makeDelegate({ audio: true })
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

  it('gives the reserved slot back when a start fails', async () => {
    // The reservation is module-level and lives for the whole process: a leak on
    // an error path would permanently shrink the budget for every camera.
    let fail = true
    const log = makeLog()
    const spawn = vi.fn(() => fakeChild())
    const delegate = new StreamingDelegate({
      deviceId: 'cam1',
      label: 'Driveway',
      log,
      client: {} as never,
      urls: { get: async () => {
        if (fail)
          throw new Error('console said no')
        return URL
      } } as never,
      caps: CAPS_SW,
      settings: () => ({ quality: 'auto', audio: false }),
      spawn,
      maxStreams: 1,
    })

    expect(await delegate.startSession('a', REQUEST, RTP)).toBe(false)
    fail = false
    // Only possible if the failed attempt released its slot.
    expect(await delegate.startSession('b', REQUEST, RTP)).toBe(true)
    delegate.stopAll()
  })

  it('tracks no session, and releases the slot, when the spawn itself throws', async () => {
    const { delegate, log } = makeDelegate({ spawn: throwingSpawn, caps: CAPS_SW, maxStreams: 1 })
    expect(await delegate.startSession('a', REQUEST, RTP)).toBe(false)
    // A dead entry would make stopAll() kill a corpse and inflate activeCount.
    expect(delegate.activeCount).toBe(0)
    expect(log.warn).toHaveBeenCalled()

    // The second of the two failure paths out of startSession. The URL failure
    // has its own test; without this one, releasing the slot only on that path
    // stays green while leaking a host-wide slot per ENOENT spawn.
    const good = makeDelegate({ caps: CAPS_SW, maxStreams: 1 })
    expect(await good.delegate.startSession('b', REQUEST, RTP)).toBe(true)
    good.delegate.stopAll()
    delegate.stopAll()
  })

  // `proc.running` is false when the child died between spawn and the check.
  // Reporting success there leaves HomeKit waiting forever on a stream nobody
  // is producing — and the old code logged "Live view started" while doing it.
  it('reports failure when the process is already dead by the time it is tracked', async () => {
    const { delegate, log } = makeDelegate({ spawn: deadSpawn })
    expect(await delegate.startSession('a', REQUEST, RTP)).toBe(false)
    expect(delegate.activeCount).toBe(0)
    expect(log.info.mock.calls.join(' ')).not.toContain('Live view started')
    expect(log.warn.mock.calls.join(' ')).toContain('exited before the stream started')
    delegate.stopAll()
  })

  // Task 5 spawns; Task 6 shuts down. A request that passed the cap check as
  // `shutdown` fired spawns ffmpeg after stopAll() drained the map, and nothing
  // then exists that would ever kill it.
  it('spawns nothing once stopAll has run, even for a request already in flight', async () => {
    let release = (): void => {}
    const { delegate, spawn } = makeDelegate({
      url: async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return URL
      },
    })

    const started = delegate.startSession('a', REQUEST, RTP)
    await new Promise(resolve => setImmediate(resolve))
    delegate.stopAll()
    release()

    expect(await started).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
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

  it('holds the slot across the await, so two cold starts cannot both pass the cap', async () => {
    // The cap counts RUNNING processes, and the stream URL is awaited before the
    // first one exists. Two starts racing through that window must not both pass.
    let release = (): void => {}
    async function parkedUrl(): Promise<string> {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return URL
    }
    const log = makeLog()
    const spawn = vi.fn(() => fakeChild())
    const delegate = new StreamingDelegate({
      deviceId: 'cam1',
      label: 'Driveway',
      log,
      client: {} as never,
      urls: { get: parkedUrl } as never,
      caps: CAPS_SW,
      settings: () => ({ quality: 'auto', audio: false }),
      spawn,
      maxStreams: 1,
    })

    const first = delegate.startSession('a', REQUEST, RTP)
    const second = delegate.startSession('b', REQUEST, RTP)
    // The first start is parked in the URL fetch — the window where no process
    // exists yet — and the second has already made its decision.
    await new Promise(resolve => setImmediate(resolve))
    release()

    expect(await Promise.all([first, second])).toEqual([true, false])
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls.join(' ')).toContain('maximum 1')
    delegate.stopAll()
  })

  it('sends audio as its own rtp output when the camera opts in', async () => {
    const { delegate, spawn, run } = makeDelegate({ audio: true })
    await delegate.startSession('a', REQUEST, RTP)
    const args = argvOf(spawn)
    expect(run).toHaveBeenCalled()
    expect(args.filter(a => a.startsWith('srtp://'))).toHaveLength(2)
    expect(args.join(' ')).toContain('srtp://192.0.2.9:5002')
    expect(args).not.toContain('-an')
    delegate.stopAll()
  })

  it('stays video-only, and never probes, when the camera has not opted in', async () => {
    const { delegate, spawn, run } = makeDelegate()
    await delegate.startSession('a', REQUEST, RTP)
    const args = argvOf(spawn)
    expect(args).toContain('-an')
    expect(args.filter(a => a.startsWith('srtp://'))).toHaveLength(1)
    expect(run).not.toHaveBeenCalled()
    delegate.stopAll()
  })

  it('encodes with the codec the probe found, and advertises that same one', async () => {
    const opus = makeDelegate({ audio: true, encoders: { opus: true } })
    await opus.delegate.startSession('a', REQUEST, RTP)
    expect(argvOf(opus.spawn).join(' ')).toContain('-c:a libopus')
    expect((await opus.delegate.audioStreamingOptions())?.codecs[0]?.type).toBe('OPUS')
    opus.delegate.stopAll()

    // The bundled static build: AAC-ELD only.
    const aac = makeDelegate({ audio: true, encoders: { aacEld: true } })
    await aac.delegate.startSession('a', REQUEST, RTP)
    expect(argvOf(aac.spawn).join(' ')).toContain('-c:a libfdk_aac')
    expect((await aac.delegate.audioStreamingOptions())?.codecs[0]?.type).toBe('AAC-eld')
    aac.delegate.stopAll()
  })

  it('advertises nothing when the camera has audio switched off', async () => {
    const { delegate } = makeDelegate({ encoders: { opus: true } })
    expect(await delegate.audioStreamingOptions()).toBeUndefined()
  })

  it('falls back to video-only, with a warning, when ffmpeg has neither audio encoder', async () => {
    const { delegate, spawn, log } = makeDelegate({ audio: true, encoders: {} })
    expect(await delegate.startSession('a', REQUEST, RTP)).toBe(true)
    const args = argvOf(spawn)
    // A broken command would be worse than no audio.
    expect(args).not.toContain('-c:a')
    expect(args).toContain('-an')
    expect(args.filter(a => a.startsWith('srtp://'))).toHaveLength(1)
    expect(log.warn.mock.calls.join(' ')).toContain('libopus or libfdk_aac')
    // Nothing may be advertised that cannot be produced.
    expect(await delegate.audioStreamingOptions()).toBeUndefined()
    delegate.stopAll()
  })

  it('falls back to video-only when the encoder probe itself fails', async () => {
    const { delegate, spawn } = makeDelegate({ audio: true, run: failingProbe })
    expect(await delegate.startSession('a', REQUEST, RTP)).toBe(true)
    expect(argvOf(spawn)).toContain('-an')
    delegate.stopAll()
  })

  it('probes the audio encoder once, not once per stream', async () => {
    const { delegate, run } = makeDelegate({ audio: true })
    await delegate.startSession('a', REQUEST, RTP)
    await delegate.startSession('b', REQUEST, RTP)
    expect(run).toHaveBeenCalledTimes(1)
    delegate.stopAll()
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
    video: { width: 1280, height: 720, fps: 30, max_bit_rate: 802, ssrc: 1, pt: 97, mtu: 1378, rtcp_interval: 0.5 },
    audio: { codec: 'AAC-eld', channel: 1, bit_rate: 0, sample_rate: 16, packet_time: 30, pt: 110, ssrc: 2, max_bit_rate: 24, rtcp_interval: 5, comfort_pt: 13, comfortNoiseEnabled: false },
  } as unknown as StreamingRequest
}

describe('streamingDelegate hap wiring', () => {
  it('prepareStream returns a port, an ssrc and the srtp material homekit sent, for both streams', async () => {
    const { delegate } = makeDelegate()
    const response = await new Promise<PrepareStreamResponse>((resolve, reject) => {
      delegate.prepareStream(prepareRequest(), (error, r) => (r ? resolve(r) : reject(error)))
    })
    const video = response.video as SourceResponse
    const audio = response.audio as SourceResponse
    expect(video.port).toBeGreaterThan(0)
    // Positive SIGNED 32-bit, on both streams: HomeKit and ffmpeg reject more.
    expect(video.ssrc).toBeGreaterThan(0)
    expect(video.ssrc).toBeLessThanOrEqual(2_147_483_647)
    expect(audio.ssrc).toBeGreaterThan(0)
    expect(audio.ssrc).toBeLessThanOrEqual(2_147_483_647)
    expect(video.srtp_key).toEqual(Buffer.alloc(16, 1))
    expect(video.srtp_salt).toEqual(Buffer.alloc(14, 2))
    // Audio has its OWN port, ssrc and key — not video's.
    expect(audio.port).not.toBe(video.port)
    expect(audio.srtp_key).toEqual(Buffer.alloc(16, 3))
    expect(audio.srtp_salt).toEqual(Buffer.alloc(14, 4))
  })

  it('start uses the prepared session and homekit payload types, and stop kills it', async () => {
    const { delegate, spawn } = makeDelegate({ audio: true })
    await new Promise<void>((resolve, reject) => {
      delegate.prepareStream(prepareRequest(), error => (error ? reject(error) : resolve()))
    })
    await new Promise<void>((resolve, reject) => {
      delegate.handleStreamRequest(startRequest(), error => (error ? reject(error) : resolve()))
    })
    const joined = argvOf(spawn).join(' ')
    // The destinations are the addresses and ports HomeKit asked for.
    expect(joined).toContain('srtp://192.0.2.9:5000')
    expect(joined).toContain('srtp://192.0.2.9:5002')
    // …and the payload types it chose, which are not the old hardcoded 99.
    expect(joined).toContain('-payload_type 97')
    expect(joined).toContain('-payload_type 110')
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
