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

/** What a spawned child did, so a test can assert on it after the fact. */
interface ChildRecord {
  stdin: string
  killed: boolean
}

/** A stand-in child that only does what FfmpegProcess touches: stdin, stderr, close, kill. */
function fakeChild(record?: ChildRecord): ChildProcess {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter, stdin: EventEmitter, kill: () => boolean }
  child.stderr = new EventEmitter()
  const stdin = new EventEmitter() as EventEmitter & { write: (chunk: string) => void, end: () => void }
  stdin.write = (chunk: string) => {
    if (record)
      record.stdin += chunk
  }
  stdin.end = () => {}
  child.stdin = stdin
  // The real child emits `close` after a kill; without it the process-wide
  // active count would never be released.
  child.kill = () => {
    if (record)
      record.killed = true
    return child.emit('close', 0)
  }
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
  talkback?: boolean
  hasSpeaker?: boolean
  encoders?: { opus?: boolean, aacEld?: boolean }
  run?: () => Promise<string>
  spawn?: () => ChildProcess
  quality?: 'auto' | 'low' | 'medium' | 'high'
  maxStreams?: number
  channel?: 'package'
  bind?: () => Promise<{ socket: never, port: number }>
  /** Omits the bind seam entirely, so the delegate binds a real UDP socket. */
  realBind?: boolean
  createTalkbackSession?: () => Promise<{ url: string, codec: string, samplingRate: number, bitsPerSample: number }>
}

const jpeg = Buffer.from('jpeg-bytes')

/** What the reference Doorbell answers: plain RTP, the CAMERA's own IP, its own rate. */
const TALKBACK_SESSION = { url: 'rtp://192.168.10.9:7004', codec: 'opus', samplingRate: 24000, bitsPerSample: 16 }

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

/** A spawn rejection whose message happens to carry a stream url. */
function throwingSpawnWithUrl(): ChildProcess {
  throw new Error(`spawn failed for ${URL}`)
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
  const createTalkbackSession = vi.fn(overrides.createTalkbackSession ?? (async () => TALKBACK_SESSION))
  const bind = vi.fn(overrides.bind ?? (async () => ({ socket: undefined as never, port: 0 })))
  const delegate = new StreamingDelegate({
    deviceId: 'cam1',
    label: 'Driveway',
    log,
    client: { getSnapshot, createTalkbackSession } as never,
    bind: (overrides.realBind ? undefined : bind) as never,
    urls: { get, clear: vi.fn() } as never,
    caps: overrides.caps ?? CAPS_HW,
    settings: () => ({ quality: overrides.quality ?? 'auto', audio: overrides.audio ?? false, talkback: overrides.talkback ?? false }),
    spawn,
    run,
    maxStreams: overrides.maxStreams,
    channel: overrides.channel,
    hasSpeaker: overrides.hasSpeaker,
  })
  return { delegate, getSnapshot, get, spawn, run, log, createTalkbackSession, bind }
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
      settings: () => ({ quality: 'auto', audio: false, talkback: false }),
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

  // Every sibling error path on this window redacts before logging; a spawn
  // rejection is the only shape whose message could plausibly carry the url
  // (a real Node ENOENT carries only the binary path, not argv, but nothing
  // should rely on that).
  it('redacts a stream url that ends up in a spawn failure message', async () => {
    const { delegate, log } = makeDelegate({ spawn: throwingSpawnWithUrl, caps: CAPS_SW, maxStreams: 1 })
    expect(await delegate.startSession('a', REQUEST, RTP)).toBe(false)

    const warned = log.warn.mock.calls.map(call => String(call[0])).join(' ')
    expect(warned).toContain('Could not start ffmpeg')
    expect(warned).not.toContain(URL)
    expect(warned).not.toContain('SENTINEL')
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
      settings: () => ({ quality: 'auto', audio: false, talkback: false }),
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

  // Talkback and `audio` are opposite directions and independent settings.
  // Codecs (and twoWayAudio) must be advertised for talkback even with the
  // microphone left off — hap-nodejs sets a stream video-only, disabling the
  // audio machinery talkback needs, when no codec is advertised at all.
  // Sending the microphone itself stays gated by `audio` in startSession.
  it('advertises two-way audio when talkback is on and audio is off', async () => {
    const { delegate } = makeDelegate({ audio: false, talkback: true, hasSpeaker: true, encoders: { opus: true } })
    const options = await delegate.audioStreamingOptions()
    expect(options?.twoWayAudio).toBe(true)
    expect(options?.codecs.length).toBeGreaterThan(0)
  })

  it('stays silent when neither audio nor talkback is on', async () => {
    const { delegate } = makeDelegate({ audio: false, talkback: false, hasSpeaker: true, encoders: { opus: true } })
    expect(await delegate.audioStreamingOptions()).toBeUndefined()
  })

  it('does not advertise two-way audio without a speaker', async () => {
    const { delegate } = makeDelegate({ audio: false, talkback: true, hasSpeaker: false, encoders: { opus: true } })
    expect(await delegate.audioStreamingOptions()).toBeUndefined()
  })

  it('never advertises two-way audio on the package lens', async () => {
    const { delegate } = makeDelegate({ audio: true, talkback: true, hasSpeaker: true, channel: 'package', encoders: { opus: true } })
    expect(await delegate.audioStreamingOptions()).toBeUndefined()
  })

  // talkbackSdp hardcodes `opus/48000/2` and buildTalkbackArgs decodes Opus.
  // On an ffmpeg without libopus the advertisement picks AAC-ELD, HomeKit then
  // sends AAC-ELD, and the doorbell speaker plays garbage with no error
  // anywhere. The container's bundled static build is exactly that ffmpeg.
  it('does not advertise two-way audio when the chosen codec is not opus', async () => {
    const { delegate } = makeDelegate({ audio: true, talkback: true, hasSpeaker: true, encoders: { aacEld: true } })
    const options = await delegate.audioStreamingOptions()
    expect(options?.codecs[0]?.type).toBe('AAC-eld')
    expect(options?.twoWayAudio).toBeFalsy()
  })

  it('advertises nothing at all when talkback is the only reason to and opus is missing', async () => {
    const { delegate } = makeDelegate({ audio: false, talkback: true, hasSpeaker: true, encoders: { aacEld: true } })
    expect(await delegate.audioStreamingOptions()).toBeUndefined()
  })

  it('does not advertise twoWayAudio when audio is on but talkback is off', async () => {
    const { delegate } = makeDelegate({ audio: true, talkback: false, hasSpeaker: true, encoders: { opus: true } })
    const options = await delegate.audioStreamingOptions()
    expect(options?.twoWayAudio).toBeFalsy()
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

  // hap-nodejs's _handleSelectedStreamConfigurationWrite dispatches
  // START_SESSION with no duplicate guard, so a retried characteristic write
  // calls handleStreamRequest('start') twice on one session id. Without a
  // guard, the second `sessions.set` overwrites the first process in the map:
  // it is left in NO map, nothing ever stops it, and it holds a maxStreams
  // slot forever.
  it('stops the previous process instead of orphaning it when a start repeats on one session id', async () => {
    const children: ChildRecord[] = []
    const { delegate } = makeDelegate({
      spawn: () => {
        const record: ChildRecord = { stdin: '', killed: false }
        children.push(record)
        return fakeChild(record)
      },
    })
    await new Promise<void>((resolve, reject) => {
      delegate.prepareStream(prepareRequest(), error => (error ? reject(error) : resolve()))
    })
    await new Promise<void>((resolve, reject) => {
      delegate.handleStreamRequest(startRequest(), error => (error ? reject(error) : resolve()))
    })
    expect(delegate.activeCount).toBe(1)

    await new Promise<void>((resolve, reject) => {
      delegate.handleStreamRequest(startRequest(), error => (error ? reject(error) : resolve()))
    })

    expect(children[0]!.killed).toBe(true)
    expect(delegate.activeCount).toBe(1)
    expect(FfmpegProcess.activeCount).toBe(1)

    delegate.stopAll()
    expect(FfmpegProcess.activeCount).toBe(0)
  })

  it('errors instead of spawning when a start arrives with no prepared session', async () => {
    const { delegate, spawn } = makeDelegate()
    const error = await new Promise(resolve => delegate.handleStreamRequest(startRequest(), resolve))
    expect(error).toBeInstanceOf(Error)
    expect(spawn).not.toHaveBeenCalled()
  })

  // hap-nodejs's BUSY guard currently refuses a second prepareStream on a
  // live session, so this path is not reachable today — kept as a defensive
  // guard, same reasoning as the `prepared` cleanup elsewhere. Without it, a
  // re-prepare on one session id would overwrite the entry and leak the
  // first talkback socket, which nothing else holds a handle to.
  it('closes the previous held socket when a session is re-prepared', async () => {
    const sockets = [fakeSocket(6100), fakeSocket(6101)]
    let calls = 0
    const { delegate } = makeDelegate({
      talkback: true,
      hasSpeaker: true,
      bind: async () => ({ socket: sockets[calls]! as never, port: 6100 + calls++ }),
    })
    await new Promise<void>((resolve, reject) => {
      delegate.prepareStream(prepareRequest(), error => (error ? reject(error) : resolve()))
    })
    expect(sockets[0]!.close).not.toHaveBeenCalled()

    await new Promise<void>((resolve, reject) => {
      delegate.prepareStream(prepareRequest(), error => (error ? reject(error) : resolve()))
    })
    expect(sockets[0]!.close).toHaveBeenCalled()
    expect(sockets[1]!.close).not.toHaveBeenCalled()

    delegate.stopSession('session-1')
  })
})

/** The socket prepareStream HOLDS for talkback, with everything the relay touches. */
function fakeSocket(port = 6100, family: 'IPv4' | 'IPv6' = 'IPv4') {
  const socket = new EventEmitter() as EventEmitter & {
    send: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    address: () => { port: number, family: string }
  }
  socket.send = vi.fn()
  socket.close = vi.fn()
  // The family is what a real bound socket reports, and the only thing the
  // delegate can ask about the socket it was handed.
  socket.address = () => ({ port, family })
  return socket
}

/** Polls rather than awaiting a fixed tick: opening binds a real loopback port. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition())
      return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('condition was never met')
}

/** The srtp material prepareRequest() sends for audio, as one key. */
const HOMEKIT_AUDIO_KEY = Buffer.concat([Buffer.alloc(16, 3), Buffer.alloc(14, 4)]).toString('base64')

async function startTalkbackSession({ ipv6, ...overrides }: DelegateOverrides & { ipv6?: boolean } = {}) {
  const socket = fakeSocket(6100, ipv6 ? 'IPv6' : 'IPv4')
  const children: ChildRecord[] = []
  /** The child objects themselves, so a test can end one by hand. */
  const procs: ChildProcess[] = []
  // The FIRST bind is the socket HomeKit talks to and is held; every later one
  // is the encoder's port reservation, which is closed again immediately.
  let nextPort = 6100
  const reserved: ReturnType<typeof fakeSocket>[] = []
  const made = makeDelegate({
    talkback: true,
    hasSpeaker: true,
    bind: async () => {
      if (nextPort++ === 6100)
        return { socket: socket as never, port: 6100 }
      const spare = fakeSocket(nextPort - 1)
      reserved.push(spare)
      return { socket: spare as never, port: nextPort - 1 }
    },
    spawn: () => {
      const record: ChildRecord = { stdin: '', killed: false }
      children.push(record)
      const child = fakeChild(record)
      procs.push(child)
      return child
    },
    ...overrides,
  })
  const { delegate } = made
  const prepared = await new Promise<PrepareStreamResponse>((resolve, reject) => {
    const request = { ...prepareRequest(), ...(ipv6 ? { addressVersion: 'ipv6' as const, targetAddress: '2001:db8::9' } : {}) }
    delegate.prepareStream(request, (error, response) => (response ? resolve(response) : reject(error)))
  })
  await new Promise<void>((resolve, reject) => {
    delegate.handleStreamRequest(startRequest(), error => (error ? reject(error) : resolve()))
  })
  return { ...made, socket, children, procs, prepared, reserved, sessionId: 'session-1' }
}

/**
 * A minimal RTP voice packet, version 2 and payload type 110 — the relay drops
 * anything that is not one, because HAP muxes its SRTCP receiver reports onto
 * the same port. `mark` is the first payload byte, so a test can identify it.
 */
function rtp(mark: number): Buffer {
  const packet = Buffer.alloc(13)
  packet[0] = 0x80
  packet[1] = 110
  packet[12] = mark
  return packet
}

/** The port ffmpeg is told to listen on — where the relay must send. */
function sdpListenPort(sdp: string): number {
  return Number(/^m=audio (\d+) /m.exec(sdp)![1])
}

describe('talkback', () => {
  it('holds the audio socket and hands homekit the port it is listening on', async () => {
    const { socket, prepared, delegate, sessionId } = await startTalkbackSession()
    expect((prepared.audio as SourceResponse).port).toBe(6100)
    expect(socket.close).not.toHaveBeenCalled()
    delegate.stopSession(sessionId)
  })

  it('reserves and closes the audio port when talkback is off', async () => {
    const { delegate, bind } = makeDelegate({ talkback: false, hasSpeaker: true })
    const prepared = await new Promise<PrepareStreamResponse>((resolve, reject) => {
      delegate.prepareStream(prepareRequest(), (error, response) => (response ? resolve(response) : reject(error)))
    })
    expect(bind).not.toHaveBeenCalled()
    expect((prepared.audio as SourceResponse).port).toBeGreaterThan(0)
  })

  // The user's invariant: talkback and `audio` are opposite directions and
  // INDEPENDENT. Every other test in this suite asserts on the second spawn,
  // so a gate of `settings.audio || settings.talkback` in startSession — which
  // would start sending the doorbell's microphone to HomeKit the moment
  // two-way is enabled — passed the whole suite. This asserts on the FIRST
  // spawn, the video session, where that mutation shows.
  it('never sends the camera microphone to homekit just because talkback is on', async () => {
    const { spawn, delegate, sessionId } = await startTalkbackSession()
    const args = argvOf(spawn, 0)
    expect(args).toContain('-an')
    expect(args).not.toContain('-c:a')
    // Exactly one outbound stream: video. A second would be the microphone.
    expect(args.filter(a => a.startsWith('srtp://'))).toHaveLength(1)
    delegate.stopSession(sessionId)
  })

  // `localrtcpport` makes ffmpeg BIND that port, and on a talkback session this
  // process holds it for the return audio: EADDRINUSE, the audio output never
  // opens, and ffmpeg exits taking the video with it. Live view was broken
  // outright for anyone with both settings on.
  it('does not ask ffmpeg to bind the port the return audio arrives on', async () => {
    const { spawn, delegate, sessionId } = await startTalkbackSession({ audio: true, encoders: { opus: true } })
    const outputs = argvOf(spawn, 0).filter(a => a.startsWith('srtp://'))
    expect(outputs).toHaveLength(2)
    const [video, audio] = outputs as [string, string]
    // The video stream keeps its own local RTCP port — it is not held here.
    expect(video).toContain('localrtcpport=')
    expect(audio).toContain(':5002?')
    expect(audio).not.toContain('localrtcpport')
    delegate.stopSession(sessionId)
  })

  it('does not touch the console or spawn an encoder until return audio arrives', async () => {
    const { createTalkbackSession, spawn, delegate, sessionId } = await startTalkbackSession()
    expect(createTalkbackSession).not.toHaveBeenCalled()
    // The video session, and nothing else.
    expect(spawn).toHaveBeenCalledTimes(1)
    delegate.stopSession(sessionId)
  })

  it('opens one console session and one encoder on the first datagram', async () => {
    const { createTalkbackSession, spawn, socket, children, delegate, sessionId } = await startTalkbackSession()
    socket.emit('message', rtp(1))
    socket.emit('message', rtp(2))
    await until(() => spawn.mock.calls.length === 2)
    expect(createTalkbackSession).toHaveBeenCalledTimes(1)
    expect(createTalkbackSession).toHaveBeenCalledWith('cam1')
    expect(children[1]!.stdin).toContain('a=crypto:1 AES_CM_128_HMAC_SHA1_80')
    // HomeKit's own key, and its payload type — not a guess.
    expect(children[1]!.stdin).toContain(`inline:${HOMEKIT_AUDIO_KEY}`)
    // startRequest() negotiates 16 kHz; an Opus SDP still declares the 48 kHz
    // RTP clock, or ffmpeg reads every timestamp three times too long.
    expect(children[1]!.stdin).toContain('a=rtpmap:110 opus/48000/2')
    delegate.stopSession(sessionId)
  })

  it('re-emits at the rate the console asked for, to the url it gave', async () => {
    const { spawn, socket, delegate, sessionId } = await startTalkbackSession({
      createTalkbackSession: async () => ({ ...TALKBACK_SESSION, samplingRate: 8000 }),
    })
    socket.emit('message', rtp(1))
    await until(() => spawn.mock.calls.length === 2)
    const args = argvOf(spawn, 1)
    expect(args[args.indexOf('-ar') + 1]).toBe('8000')
    expect(args.at(-1)).toBe('rtp://192.168.10.9:7004')
    delegate.stopSession(sessionId)
  })

  it('forwards the buffered datagrams to the port the encoder listens on', async () => {
    const { socket, children, delegate, sessionId } = await startTalkbackSession()
    const packet = rtp(3)
    socket.emit('message', packet)
    await until(() => socket.send.mock.calls.length > 0)
    const port = sdpListenPort(children[1]!.stdin)
    expect(socket.send.mock.calls[0]![0]).toBe(packet)
    expect(socket.send.mock.calls[0]![1]).toBe(port)
    expect(socket.send.mock.calls[0]![2]).toBe('127.0.0.1')
    delegate.stopSession(sessionId)
  })

  // A udp6 socket cannot send to an IPv4 literal: dgram resolves the
  // destination as family 6 and errors into the send callback, so an
  // IPv6 session used to open the console session, spawn ffmpeg, and deliver
  // nothing at all — silently.
  it('keeps the sdp, the reserved port and the forward destination in one family on ipv6', async () => {
    const { spawn, socket, children, delegate, sessionId, bind } = await startTalkbackSession({ ipv6: true })
    const packet = rtp(3)
    socket.emit('message', packet)
    await until(() => socket.send.mock.calls.length > 0)
    // BOTH binds — the held socket and the encoder's port reservation — asked
    // for the v6 family. A v4-reserved port number is no proof the same port is
    // free on udp6, which is where ffmpeg is about to bind it.
    expect(bind.mock.calls).toEqual([[true], [true]])
    const sdp = children[1]!.stdin
    expect(sdp).toContain('c=IN IP6 ::1')
    expect(sdp).not.toContain('127.0.0.1')
    // The relay sends to the v6 loopback, at the port the SDP names.
    expect(socket.send.mock.calls[0]![2]).toBe('::1')
    expect(socket.send.mock.calls[0]![1]).toBe(sdpListenPort(sdp))
    expect(spawn).toHaveBeenCalledTimes(2)
    delegate.stopSession(sessionId)
  })

  it('uses the v4 loopback for a v4 session, and frees the port for the encoder', async () => {
    const { socket, children, delegate, sessionId, bind, reserved } = await startTalkbackSession()
    socket.emit('message', rtp(1))
    await until(() => socket.send.mock.calls.length > 0)
    expect(bind.mock.calls).toEqual([[false], [false]])
    // The encoder's port is only RESERVED: ffmpeg binds it itself, and cannot
    // if this process is still holding it.
    expect(reserved[0]!.close).toHaveBeenCalled()
    expect(children[1]!.stdin).toContain('c=IN IP4 127.0.0.1')
    expect(socket.send.mock.calls[0]![2]).toBe('127.0.0.1')
    delegate.stopSession(sessionId)
  })

  it('does not count talkback against the transcode cap', async () => {
    const { spawn, socket, delegate, sessionId } = await startTalkbackSession()
    socket.emit('message', rtp(1))
    await until(() => spawn.mock.calls.length === 2)
    // Both the per-camera map and the host-wide counter the cap actually reads.
    expect(delegate.activeCount).toBe(1)
    expect(FfmpegProcess.activeCount).toBe(1)
    delegate.stopSession(sessionId)
  })

  it('kills the encoder and closes the socket on stop', async () => {
    const { spawn, socket, children, delegate, sessionId } = await startTalkbackSession()
    socket.emit('message', rtp(1))
    await until(() => spawn.mock.calls.length === 2)
    delegate.stopSession(sessionId)
    expect(children[1]!.killed).toBe(true)
    expect(socket.close).toHaveBeenCalled()
    // Nothing is forwarded after the teardown.
    const forwarded = socket.send.mock.calls.length
    socket.emit('message', rtp(9))
    expect(socket.send.mock.calls.length).toBe(forwarded)
  })

  it('kills the encoder and closes the socket on stopAll', async () => {
    const { spawn, socket, children, delegate } = await startTalkbackSession()
    socket.emit('message', rtp(1))
    await until(() => spawn.mock.calls.length === 2)
    delegate.stopAll()
    expect(children[1]!.killed).toBe(true)
    expect(socket.close).toHaveBeenCalled()
  })

  it('closes the held socket even when the session is stopped before any speech', async () => {
    const { socket, delegate } = await startTalkbackSession()
    delegate.stopAll()
    expect(socket.close).toHaveBeenCalled()
  })

  // The console POST took 120-195 ms live: a viewer looking away inside that
  // window is ordinary, and the relay alone cannot clean up — it does not own
  // the encoder it asked for.
  it('kills an encoder whose open resolved after the session was torn down', async () => {
    let release: () => void = () => {}
    const { spawn, socket, children, delegate, sessionId, createTalkbackSession } = await startTalkbackSession({
      createTalkbackSession: async () => new Promise((resolve) => {
        release = () => resolve(TALKBACK_SESSION)
      }),
    })
    socket.emit('message', rtp(1))
    await until(() => createTalkbackSession.mock.calls.length === 1)
    delegate.stopSession(sessionId)
    release()
    await until(() => spawn.mock.calls.length === 2)
    expect(children[1]!.killed).toBe(true)
    expect(FfmpegProcess.activeCount).toBe(0)
  })

  // The SDP carries the session's SRTP key. It goes on stdin precisely so the
  // secret never reaches disk; a log line would undo that.
  it('never logs the sdp, the key or the talkback arguments', async () => {
    const { spawn, socket, delegate, sessionId, log } = await startTalkbackSession()
    socket.emit('message', rtp(1))
    await until(() => spawn.mock.calls.length === 2)
    delegate.stopSession(sessionId)
    const logged = [...log.info.mock.calls, ...log.warn.mock.calls, ...log.debug.mock.calls].map(call => inspect(call)).join(' ')
    expect(logged).not.toContain(HOMEKIT_AUDIO_KEY)
    expect(logged).not.toContain('a=crypto')
    expect(logged).not.toContain('inline:')
    expect(logged).not.toContain('rtp://192.168.10.9:7004')
    // The key is not on the command line either — only stdin carries it.
    expect(argvOf(spawn, 1).join(' ')).not.toContain(HOMEKIT_AUDIO_KEY)
  })

  // Tapping away while the stream url is still in flight. stopSession is
  // synchronous and closes the held socket, but startSession was parked: it
  // came back, spawned, registered under an already-stopped id and armed the
  // relay on a CLOSED dgram handle. Three failures at once — an unhandled
  // ERR_SOCKET_DGRAM_NOT_RUNNING, HAP's callback never firing, and a 4 MP
  // transcode nothing can ever stop, holding a maxStreams slot for good.
  it('neither arms talkback nor orphans the transcode when the viewer taps away mid-start', async () => {
    const socket = fakeSocket()
    const children: ChildRecord[] = []
    let release: (url: string) => void = () => {}
    const { delegate, spawn, get, createTalkbackSession } = makeDelegate({
      talkback: true,
      hasSpeaker: true,
      bind: async () => ({ socket: socket as never, port: 6100 }),
      url: () => new Promise<string>((resolve) => {
        release = resolve
      }),
      spawn: () => {
        const record: ChildRecord = { stdin: '', killed: false }
        children.push(record)
        return fakeChild(record)
      },
    })
    await new Promise<PrepareStreamResponse>((resolve, reject) => {
      delegate.prepareStream(prepareRequest(), (error, response) => (response ? resolve(response) : reject(error)))
    })
    const outcome = new Promise<unknown>(resolve => delegate.handleStreamRequest(startRequest(), resolve))
    await until(() => get.mock.calls.length === 1)
    delegate.stopSession('session-1')
    release(URL)

    // HAP is answered at all — the bug left this promise pending forever.
    expect(await outcome).toBeInstanceOf(Error)
    // The transcode that started anyway is stopped, not left in the map.
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(children[0]!.killed).toBe(true)
    expect(delegate.activeCount).toBe(0)
    expect(FfmpegProcess.activeCount).toBe(0)
    expect(socket.close).toHaveBeenCalled()
    // And nothing was armed on the socket that stopSession already closed.
    socket.emit('message', rtp(1))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(createTalkbackSession).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  // The second half of the same guard, isolated. In the tap-away case above
  // startSession already refuses, so the arm site is never reached; this is the
  // case where the start SUCCEEDS but the prepared entry it began with is no
  // longer the current one. Arming then would bind the relay to a socket
  // nothing owns any more — the stale one, while HomeKit talks to the new port.
  it('never arms a socket from a prepared entry that has since been replaced', async () => {
    const stale = fakeSocket(6100)
    const fresh = fakeSocket(6200)
    const sockets = [stale, fresh]
    let release: (url: string) => void = () => {}
    const { delegate, spawn, get, createTalkbackSession } = makeDelegate({
      talkback: true,
      hasSpeaker: true,
      bind: async () => {
        const socket = sockets.shift()!
        return { socket: socket as never, port: socket.address().port }
      },
      url: () => new Promise<string>((resolve) => {
        release = resolve
      }),
    })
    const prepare = () => new Promise<PrepareStreamResponse>((resolve, reject) => {
      delegate.prepareStream(prepareRequest(), (error, response) => (response ? resolve(response) : reject(error)))
    })
    await prepare()
    const outcome = new Promise<unknown>(resolve => delegate.handleStreamRequest(startRequest(), resolve))
    await until(() => get.mock.calls.length === 1)
    // A re-prepare on the same session id, landing while the start is parked.
    expect((await prepare()).audio).toMatchObject({ port: 6200 })
    release(URL)
    expect(await outcome).toBeUndefined()

    stale.emit('message', rtp(1))
    fresh.emit('message', rtp(1))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(createTalkbackSession).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
    delegate.stopSession('session-1')
  })

  // hap-nodejs mints a fresh session id per attempt, so against a flapping
  // console every retry used to leave one more bound socket behind.
  it('releases the held socket when the start fails', async () => {
    const socket = fakeSocket()
    const { delegate } = makeDelegate({
      talkback: true,
      hasSpeaker: true,
      bind: async () => ({ socket: socket as never, port: 6100 }),
      url: failingUrl,
    })
    await new Promise<PrepareStreamResponse>((resolve, reject) => {
      delegate.prepareStream(prepareRequest(), (error, response) => (response ? resolve(response) : reject(error)))
    })
    const error = await new Promise<unknown>(resolve => delegate.handleStreamRequest(startRequest(), resolve))
    expect(error).toBeInstanceOf(Error)
    expect(socket.close).toHaveBeenCalled()
  })

  // HomeKit reuses session ids. The old relay keeps its listener on the SHARED
  // socket, so it double-forwards, and its encoder's RTP input never EOFs —
  // `counted: false` means activeCount never shows it either.
  it('takes down the previous relay when a start repeats on one session id', async () => {
    const { spawn, socket, children, delegate, sessionId } = await startTalkbackSession()
    socket.emit('message', rtp(1))
    await until(() => spawn.mock.calls.length === 2)
    const firstEncoder = children[1]!

    await new Promise<void>((resolve, reject) => {
      delegate.handleStreamRequest(startRequest(), error => (error ? reject(error) : resolve()))
    })
    expect(firstEncoder.killed).toBe(true)

    // One forward per packet, not two, and it goes to the NEW encoder.
    const before = socket.send.mock.calls.length
    socket.emit('message', rtp(2))
    await until(() => spawn.mock.calls.length === 4)
    await until(() => socket.send.mock.calls.length > before)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(socket.send.mock.calls.length - before).toBe(1)
    expect(socket.send.mock.calls.at(-1)![1]).toBe(sdpListenPort(children[3]!.stdin))

    // The first start's VIDEO process must itself have been stopped by the
    // repeat start above — not left orphaned in no map. See the guard in
    // startSession just before `this.sessions.set(sessionId, proc)`.
    expect(children[0]!.killed).toBe(true)

    delegate.stopSession(sessionId)
    expect(FfmpegProcess.activeCount).toBe(0)
  })

  // Every other test injects the bind seam, which leaves socket.address().port
  // and the on('error') wiring — the two lines the whole path stands on —
  // never executed at all.
  it('binds a real udp socket when nothing is injected', async () => {
    const { delegate } = makeDelegate({ talkback: true, hasSpeaker: true, realBind: true })
    const prepared = await new Promise<PrepareStreamResponse>((resolve, reject) => {
      delegate.prepareStream(prepareRequest(), (error, response) => (response ? resolve(response) : reject(error)))
    })
    const port = (prepared.audio as SourceResponse).port
    expect(port).toBeGreaterThan(0)
    expect(Number.isInteger(port)).toBe(true)
    // Releases the real socket; a leak here would show as an open handle.
    delegate.stopSession('session-1')
  })

  it('warns without leaking when the console refuses the talkback session', async () => {
    const { spawn, socket, delegate, sessionId, log } = await startTalkbackSession({
      createTalkbackSession: async () => {
        throw Object.assign(new Error('503 DOWNSTREAM_ERROR'), { cause: { apiKey: 'SECRET-KEY' } })
      },
    })
    socket.emit('message', rtp(1))
    await until(() => log.warn.mock.calls.length > 0)
    expect(inspect(log.warn.mock.calls)).toContain('503 DOWNSTREAM_ERROR')
    expect(inspect(log.warn.mock.calls)).not.toContain('SECRET-KEY')
    // Nothing was spawned, and nothing is forwarded.
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(socket.send).not.toHaveBeenCalled()
    delegate.stopSession(sessionId)
  })

  // Talkback used to log only on failure: a working session and a silent
  // no-op were indistinguishable in the log, which is exactly what made the
  // hardware gate impossible to diagnose from logs alone. This is the
  // positive line, and it must name the camera only — never the console's
  // talkback endpoint (its IP and port) or anything from the SDP.
  it('logs when talkback actually starts, naming the camera and not the endpoint', async () => {
    const { socket, delegate, sessionId, log } = await startTalkbackSession()
    socket.emit('message', rtp(1))
    await until(() => log.info.mock.calls.some(call => String(call[0]).includes('Talkback started')))
    const line = log.info.mock.calls.map(call => String(call[0])).find(m => m.includes('Talkback started'))!
    expect(line).toBe('Talkback started for "Driveway" (24000 Hz).')
    expect(line).not.toContain('192.168.10.9')
    expect(line).not.toContain('7004')
    delegate.stopSession(sessionId)
  })

  it('does not log a talkback start when the encoder fails to start', async () => {
    let calls = 0
    const { socket, delegate, sessionId, log } = await startTalkbackSession({
      spawn: () => {
        calls++
        // First spawn is the video session and must succeed so the talkback
        // relay arms; the second is the encoder, which dies before running.
        return calls === 1 ? fakeChild() : deadSpawn()
      },
    })
    socket.emit('message', rtp(1))
    await until(() => calls === 2)
    expect(log.info.mock.calls.some(call => String(call[0]).includes('Talkback started'))).toBe(false)
    delegate.stopSession(sessionId)
  })
})

const PKG_CAPS = { path: '/usr/bin/ffmpeg', encoder: 'h264_vaapi' as const, hwaccel: 'vaapi' as const }
const PKG_URL = 'rtsps://192.0.2.1:7441/pkg?token=SENTINEL'

function pkgTarget() {
  return { port: 5000, ssrc: 1, payloadType: 99, key: Buffer.alloc(30), localPort: 6000 }
}

describe('package channel', () => {
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }

  function makeDelegate(channel?: 'package') {
    const urls = { get: vi.fn(async () => PKG_URL) }
    const getSnapshot = vi.fn(async () => Buffer.from(channel ?? 'main'))
    const spawn = vi.fn(() => {
      throw new Error('should not spawn in this test')
    })
    const delegate = new StreamingDelegate({
      deviceId: 'cam1',
      label: 'Doorbell Package Camera',
      log,
      client: { getSnapshot } as never,
      urls: urls as never,
      caps: PKG_CAPS,
      channel,
      settings: () => ({ quality: 'auto', audio: true, talkback: false }),
      spawn: spawn as never,
    })
    return { delegate, urls, getSnapshot }
  }

  it('requests the package channel rather than a selected substream', async () => {
    const { delegate, urls } = makeDelegate('package')
    const resolved = await delegate.streamUrlFor({ width: 1920, height: 1080 })
    expect(urls.get).toHaveBeenCalledWith('cam1', 'package')
    // Returned alongside the URL, and it is what the session logs: reading the
    // settings again later would name a channel this session is not streaming.
    expect(resolved.channel).toBe('package')
  })

  it('still selects a substream when no channel is given', async () => {
    const { delegate, urls } = makeDelegate()
    const resolved = await delegate.streamUrlFor({ width: 1280, height: 720 })
    expect(urls.get).toHaveBeenCalledWith('cam1', 'medium')
    expect(resolved.channel).toBe('medium')
  })

  // Without the channel the console answers with the MAIN lens, so the package
  // accessory's tile in Home.app shows the wrong camera entirely.
  it('asks the console for the package lens when snapshotting a package delegate', async () => {
    const { delegate, getSnapshot } = makeDelegate('package')
    await delegate.snapshot()
    expect(getSnapshot).toHaveBeenCalledWith('cam1', { channel: 'package' })
  })

  it('asks for no channel at all on an ordinary camera', async () => {
    const { delegate, getSnapshot } = makeDelegate()
    await delegate.snapshot()
    expect(getSnapshot).toHaveBeenCalledWith('cam1', {})
  })

  // The 2s cache lives on the delegate, and each lens has its own delegate.
  it('does not let one lens serve the other lens image from cache', async () => {
    const main = makeDelegate()
    const pkg = makeDelegate('package')
    expect((await main.delegate.snapshot()).toString()).toBe('main')
    expect((await pkg.delegate.snapshot()).toString()).toBe('package')
  })

  it('never requests audio on a package delegate, even when the camera opted in', async () => {
    const { delegate } = makeDelegate('package')
    expect(await delegate.audioStreamingOptions()).toBeUndefined()
  })
})

describe('buildFfmpegArgs frame-rate padding', () => {
  const base = { url: PKG_URL, bitrate: 800, address: '192.0.2.9', video: pkgTarget() }

  it('emits -r when an fps is supplied', () => {
    const args = buildFfmpegArgs(PKG_CAPS, { ...base, fps: 15 })
    expect(args).toContain('-r')
    expect(args[args.indexOf('-r') + 1]).toBe('15')
  })

  it('places -r before -f rtp, so it applies to the output that follows it', () => {
    // Position, not presence: ffmpeg applies an output option to the output
    // that comes AFTER it, so `-r` appended past the output URL is dangling
    // and never reaches the encoder — the defect this guards against.
    const args = buildFfmpegArgs(PKG_CAPS, { ...base, fps: 15 })
    expect(args.indexOf('-r')).toBeLessThan(args.indexOf('-f'))
  })

  it('omits -r when no fps is supplied', () => {
    expect(buildFfmpegArgs(PKG_CAPS, base)).not.toContain('-r')
  })
})

describe('buildFfmpegArgs scaling', () => {
  const base = { url: PKG_URL, bitrate: 800, address: '192.0.2.9', video: pkgTarget() }
  const scale = { width: 1280, height: 960 }

  const QSV_CAPS = { path: '/usr/bin/ffmpeg', encoder: 'h264_qsv' as const, hwaccel: 'qsv' as const }

  // Software decode, software scale, upload for a hardware encode. In-GPU
  // scaling (`scale_vaapi`) fails on the reference hardware with "Cannot
  // allocate memory"; this form is the one measured working there.
  const expected = [
    { name: 'vaapi', caps: PKG_CAPS, filter: 'scale=1280:960,format=nv12,hwupload' },
    { name: 'qsv', caps: QSV_CAPS, filter: 'scale=1280:960,format=nv12,hwupload=extra_hw_frames=64' },
    { name: 'software', caps: { path: '/usr/bin/ffmpeg', encoder: 'libx264' as const }, filter: 'scale=1280:960' },
  ]

  for (const { name, caps, filter } of expected) {
    it(`uses the ${name} scale filter with the negotiated size`, () => {
      const args = buildFfmpegArgs(caps, { ...base, scale })
      expect(args).toContain('-vf')
      expect(args[args.indexOf('-vf') + 1]).toBe(filter)
    })
  }

  it('follows the negotiated size rather than a constant', () => {
    const args = buildFfmpegArgs(PKG_CAPS, { ...base, scale: { width: 640, height: 480 } })
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=640:480,format=nv12,hwupload')
  })

  it('drops hardware DECODE when scaling, keeping the hardware encoder', () => {
    // The whole point of the change: hwaccel decode plus a filter is what blew
    // up on the real console. The encoder must still be the hardware one.
    const args = buildFfmpegArgs(PKG_CAPS, { ...base, scale })
    expect(args).not.toContain('-hwaccel')
    expect(args).not.toContain('-hwaccel_output_format')
    expect(args[args.indexOf('-c:v') + 1]).toBe(PKG_CAPS.encoder)
  })

  it('initialises the encode device before the input, per encoder', () => {
    const vaapi = buildFfmpegArgs(PKG_CAPS, { ...base, scale })
    expect(vaapi[vaapi.indexOf('-vaapi_device') + 1]).toBe('/dev/dri/renderD128')
    expect(vaapi.indexOf('-vaapi_device')).toBeLessThan(vaapi.indexOf('-i'))

    const qsv = buildFfmpegArgs(QSV_CAPS, { ...base, scale })
    expect(qsv[qsv.indexOf('-init_hw_device') + 1]).toBe('qsv=hw')
    expect(qsv[qsv.indexOf('-filter_hw_device') + 1]).toBe('hw')
    expect(qsv.indexOf('-init_hw_device')).toBeLessThan(qsv.indexOf('-i'))
    expect(qsv).not.toContain('-hwaccel')

    // Software encoder needs no device at all.
    const sw = buildFfmpegArgs(CAPS_SW, { ...base, scale })
    expect(sw).not.toContain('-vaapi_device')
    expect(sw).not.toContain('-init_hw_device')
  })

  it('keeps hardware decode on the unscaled main-camera path', () => {
    const args = buildFfmpegArgs(PKG_CAPS, base)
    expect(args[args.indexOf('-hwaccel') + 1]).toBe('vaapi')
    expect(args[args.indexOf('-hwaccel_output_format') + 1]).toBe('vaapi')
    expect(args).not.toContain('-vaapi_device')
  })

  it('places -vf before -f rtp and the output url, so it applies to that output', () => {
    // Position, not presence: an output option after the output URL dangles and
    // never reaches the encoder. `-r` shipped broken that way once already.
    const args = buildFfmpegArgs(PKG_CAPS, { ...base, scale })
    expect(args.indexOf('-vf')).toBeLessThan(args.indexOf('-f'))
    expect(args.indexOf('-vf')).toBeLessThan(args.findIndex(a => a.startsWith('srtp://')))
    // And after the input, not among the input options — an input-side -vf is
    // not a thing ffmpeg accepts.
    expect(args.indexOf('-vf')).toBeGreaterThan(args.indexOf('-i'))
  })

  it('adds no filter when no size is given, leaving the main-camera path alone', () => {
    expect(buildFfmpegArgs(PKG_CAPS, base)).not.toContain('-vf')
    expect(buildFfmpegArgs(CAPS_SW, base)).not.toContain('-vf')
  })
})

/**
 * hap-nodejs does not check a paired controller's selection against the ladder
 * the accessory advertised, so every number here reaches ffmpeg verbatim unless
 * something clamps it. `-r 0` makes ffmpeg refuse to start at all.
 */
describe('buildFfmpegArgs clamps the negotiated parameters', () => {
  const base = { url: PKG_URL, bitrate: 800, address: '192.0.2.9', video: pkgTarget(), scale: { width: 1280, height: 960 } }
  const rate = (fps: number) => {
    const args = buildFfmpegArgs(PKG_CAPS, { ...base, fps })
    return args[args.indexOf('-r') + 1]
  }
  const filter = (scale: { width: number, height: number }) => {
    const args = buildFfmpegArgs(PKG_CAPS, { ...base, scale, fps: 30 })
    return args[args.indexOf('-vf') + 1]
  }

  for (const fps of [0, -1, -30, Number.NaN, Number.POSITIVE_INFINITY, 0.4]) {
    it(`turns a negotiated fps of ${fps} into the advertised rate, never -r 0`, () => {
      expect(rate(fps)).toBe('30')
    })
  }

  it('rounds a fractional rate rather than handing ffmpeg a decimal', () => {
    expect(rate(23.6)).toBe('24')
  })

  it('caps a rate above anything advertised', () => {
    expect(rate(240)).toBe('30')
  })

  it('leaves a rate the ladder actually offers alone', () => {
    expect(rate(24)).toBe('24')
  })

  it('bounds absurd dimensions by the largest advertised size', () => {
    expect(filter({ width: 1_000_000_000, height: 1_000_000_000 })).toBe('scale=1600:1200,format=nv12,hwupload')
  })

  for (const [name, scale] of [
    ['zero', { width: 0, height: 0 }],
    ['negative', { width: -1280, height: -960 }],
    ['nan', { width: Number.NaN, height: Number.NaN }],
    ['infinite', { width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY }],
  ] as const) {
    it(`falls back to the native size for a ${name} dimension`, () => {
      expect(filter(scale)).toBe('scale=1600:1200,format=nv12,hwupload')
    })
  }

  // 4:2:0 chroma has no half-pixels; an odd size fails the encoder outright.
  it('rounds a made-up size down to an even one', () => {
    expect(filter({ width: 641, height: 481 })).toBe('scale=640:480,format=nv12,hwupload')
  })

  it('leaves a size the ladder actually offers alone', () => {
    expect(filter({ width: 1024, height: 768 })).toBe('scale=1024:768,format=nv12,hwupload')
  })

  // The main camera negotiates the same numbers but supplies neither field, so
  // nothing here may start emitting one for it.
  it('adds neither -r nor -vf to the main-camera path', () => {
    const args = buildFfmpegArgs(CAPS_HW, { url: PKG_URL, bitrate: 800, address: '192.0.2.9', video: pkgTarget() })
    expect(args).not.toContain('-r')
    expect(args).not.toContain('-vf')
  })
})

describe('package session honours what homekit negotiated', () => {
  // 1024x768@24 — neither the lens's native size nor the old hardcoded 15 fps,
  // so a constant anywhere in the path shows up here.
  const negotiated = { ...REQUEST, width: 1024, height: 768, fps: 24 }

  it('scales to and pads to the negotiated size and rate', async () => {
    const { delegate, spawn } = makeDelegate({ channel: 'package' })
    expect(await delegate.startSession('a', negotiated, RTP)).toBe(true)
    const args = argvOf(spawn)
    // Torn down BEFORE the assertions: a failing expect would otherwise leave
    // the process-wide count non-zero and fail every later test with it.
    delegate.stopAll()
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=1024:768,format=nv12,hwupload')
    expect(args[args.indexOf('-r') + 1]).toBe('24')
  })

  it('leaves the main-camera path with neither a filter nor a forced rate', async () => {
    const { delegate, spawn } = makeDelegate()
    expect(await delegate.startSession('a', negotiated, RTP)).toBe(true)
    const args = argvOf(spawn)
    delegate.stopAll()
    expect(args).not.toContain('-vf')
    expect(args).not.toContain('-r')
  })
})

/**
 * A `kill()` that returns false means the signal was NOT delivered and the
 * process is still running — still decoding, and still holding one of the
 * host-wide stream slots that only its exit releases. Dropping it from the
 * session map at that point leaves nobody holding a handle to retry.
 */
describe('a session whose kill does not land', () => {
  /** Refuses SIGKILL until `allow()` is called, then behaves like fakeChild. */
  function stubbornChild() {
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter, kill: () => boolean }
    child.stderr = new EventEmitter()
    let killable = false
    child.kill = () => {
      if (!killable)
        return false
      child.emit('close', 0)
      return true
    }
    return { child: child as unknown as ChildProcess, allow: () => {
      killable = true
    } }
  }

  it('stays tracked and keeps holding its slot, and a retry kills it', async () => {
    const { child, allow } = stubbornChild()
    const { delegate } = makeDelegate({ spawn: () => child })
    expect(await delegate.startSession('a', REQUEST, RTP)).toBe(true)

    delegate.stopAll()

    // Both counts are the point: the orphan is still ours to retry, and it
    // still counts against the cap because it is genuinely still running.
    expect(delegate.activeCount).toBe(1)
    expect(FfmpegProcess.activeCount).toBe(1)

    allow()
    delegate.stopAll()

    expect(delegate.activeCount).toBe(0)
    expect(FfmpegProcess.activeCount).toBe(0)
  })

  it('is retried by stopSession too, not only by the shutdown drain', async () => {
    const { child, allow } = stubbornChild()
    const { delegate } = makeDelegate({ spawn: () => child })
    await delegate.startSession('a', REQUEST, RTP)

    delegate.stopSession('a')
    expect(delegate.activeCount).toBe(1)

    allow()
    delegate.stopSession('a')
    expect(delegate.activeCount).toBe(0)
    expect(FfmpegProcess.activeCount).toBe(0)
  })

  it('drops a process that exits on its own and releases its slot', async () => {
    const child = fakeChild()
    const { delegate } = makeDelegate({ spawn: () => child })
    await delegate.startSession('a', REQUEST, RTP)
    expect(delegate.activeCount).toBe(1)

    // ffmpeg died by itself — nothing called stop(), so only onExit can clear
    // the entry. A map that only shrinks on stop() would grow without bound.
    ;(child as unknown as EventEmitter).emit('close', 0)

    expect(delegate.activeCount).toBe(0)
    expect(FfmpegProcess.activeCount).toBe(0)
  })
})

// HomeKit reuses session ids, so a retained orphan and a fresh session can end
// up sharing one. The orphan's exit must not evict the live session with it.
describe('a late exit from an orphaned process', () => {
  it('does not untrack the session that reused its id', async () => {
    const orphan = new EventEmitter() as EventEmitter & { stderr: EventEmitter, kill: () => boolean }
    orphan.stderr = new EventEmitter()
    orphan.kill = () => false
    const live = fakeChild()
    const children = [orphan as unknown as ChildProcess, live]
    const { delegate } = makeDelegate({ spawn: () => children.shift()! })

    await delegate.startSession('a', REQUEST, RTP)
    delegate.stopSession('a')
    await delegate.startSession('a', REQUEST, RTP)

    ;(orphan as EventEmitter).emit('close', 0)

    // The live session is still there — and still the one a stop request kills.
    expect(delegate.activeCount).toBe(1)
    delegate.stopAll()
    expect(delegate.activeCount).toBe(0)
    expect(FfmpegProcess.activeCount).toBe(0)
  })
})
