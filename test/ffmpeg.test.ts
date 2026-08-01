import type { SpawnFn } from '../src/protect/ffmpeg.js'
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { inspect } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { chooseEncoder, FfmpegProcess, probeFfmpeg, redactStreamUrls } from '../src/protect/ffmpeg.js'

const fixture = (n: string) => JSON.parse(readFileSync(`test/fixtures/ffmpeg/${n}.json`, 'utf8'))

describe('chooseEncoder', () => {
  it('prefers qsv when the real hardware build offers it', () => {
    const { hwaccels, encoders } = fixture('hardware')
    expect(chooseEncoder(hwaccels, encoders)).toEqual({ encoder: 'h264_qsv', hwaccel: 'qsv' })
  })

  it('falls back to libx264 on the real software-only build', () => {
    const { hwaccels, encoders } = fixture('software')
    expect(chooseEncoder(hwaccels, encoders)).toEqual({ encoder: 'libx264' })
  })

  it('uses vaapi when qsv is absent', () => {
    const { encoders } = fixture('hardware')
    expect(chooseEncoder('vaapi\ndrm\n', encoders)).toEqual({ encoder: 'h264_vaapi', hwaccel: 'vaapi' })
  })

  // The encoder list contains `hevc_qsv` and `mjpeg_qsv` too. A substring match
  // on "qsv" would pass while selecting a codec HomeKit cannot decode.
  it('does not mistake hevc_qsv for an H.264 encoder', () => {
    expect(chooseEncoder('qsv\n', ' V..... hevc_qsv HEVC (Intel Quick Sync)\n V....D libx264 libx264 H.264\n'))
      .toEqual({ encoder: 'libx264' })
  })
})

describe('probeFfmpeg', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

  it('picks the hardware-capable path even when a software one comes first', async () => {
    const hw = fixture('hardware')
    const sw = fixture('software')
    const run = vi.fn(async (path: string, args: string[]) => {
      const f = path === '/usr/bin/ffmpeg' ? hw : sw
      return args.includes('-hwaccels') ? f.hwaccels : f.encoders
    })
    const caps = await probeFfmpeg({ log, run, candidates: ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'] })
    expect(caps).toEqual({ path: '/usr/bin/ffmpeg', encoder: 'h264_qsv', hwaccel: 'qsv' })
  })

  it('honours a configured path without probing others', async () => {
    const hw = fixture('hardware')
    const run = vi.fn(async (_p: string, args: string[]) => args.includes('-hwaccels') ? hw.hwaccels : hw.encoders)
    const caps = await probeFfmpeg({ log, run, candidates: ['/a', '/b'], configuredPath: '/custom/ffmpeg' })
    expect(caps.path).toBe('/custom/ffmpeg')
    expect(run).toHaveBeenCalledWith('/custom/ffmpeg', expect.arrayContaining(['-hwaccels']))
    expect(run).not.toHaveBeenCalledWith('/a', expect.anything())
  })

  it('falls back to a runnable software binary when none support hardware', async () => {
    const sw = fixture('software')
    const run = vi.fn(async (path: string, args: string[]) => {
      if (path === '/missing')
        throw new Error('ENOENT')
      return args.includes('-hwaccels') ? sw.hwaccels : sw.encoders
    })
    const caps = await probeFfmpeg({ log, run, candidates: ['/missing', '/usr/local/bin/ffmpeg'] })
    expect(caps).toEqual({ path: '/usr/local/bin/ffmpeg', encoder: 'libx264' })
  })

  it('throws when no candidate runs at all', async () => {
    const run = vi.fn(async () => {
      throw new Error('ENOENT')
    })
    await expect(probeFfmpeg({ log, run, candidates: ['/a'] })).rejects.toThrow(/no usable ffmpeg/i)
  })
})

const SECRET = 'SENTINEL-TOKEN-DO-NOT-LOG'
const URL = `rtsps://192.0.2.1:7441/live?token=${SECRET}`

function fakeSpawn() {
  const proc = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    kill: vi.fn(),
    killed: false,
  })
  const spawn: SpawnFn = vi.fn(() => proc as unknown as ReturnType<SpawnFn>)
  return { proc, spawn }
}

describe('redactStreamUrls', () => {
  it('removes an rtsps url', () => {
    expect(redactStreamUrls(`opening ${URL} now`)).not.toContain(SECRET)
  })

  it('removes a url from a full ffmpeg command echo', () => {
    const echo = `ffmpeg -rtsp_transport tcp -i ${URL} -c:v libx264 -f rtp srtp://...`
    const out = redactStreamUrls(echo)
    expect(out).not.toContain(SECRET)
    expect(out).toContain('-c:v libx264')
  })

  it('leaves text without urls untouched', () => {
    expect(redactStreamUrls('no url here')).toBe('no url here')
  })
})

describe('ffmpegProcess', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

  it('never lets a stream url reach the log on failure', () => {
    log.warn.mockClear()
    const { proc, spawn } = fakeSpawn()
    const p = new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: ['-i', URL], log, spawn })
    p.start()
    proc.stderr.emit('data', Buffer.from(`Error opening input ${URL}\n`))
    proc.emit('close', 1)

    const logged = inspect(log.warn.mock.calls, { depth: 10 })
    expect(logged).not.toContain(SECRET)
    expect(log.warn.mock.calls.flat().every(a => typeof a === 'string')).toBe(true)
  })

  it('tracks and releases an active slot', () => {
    const { proc, spawn } = fakeSpawn()
    const p = new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, spawn })
    p.start()
    expect(p.running).toBe(true)
    proc.emit('close', 0)
    expect(p.running).toBe(false)
  })

  it('stop() is idempotent', () => {
    const { proc, spawn } = fakeSpawn()
    const p = new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, spawn })
    p.start()
    p.stop()
    p.stop()
    expect(proc.kill).toHaveBeenCalledTimes(1)
  })

  it('activeCount reflects running processes and returns to zero after teardown', () => {
    const before = FfmpegProcess.activeCount
    const { proc: proc1, spawn: spawn1 } = fakeSpawn()
    const { proc: proc2, spawn: spawn2 } = fakeSpawn()
    const p1 = new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, spawn: spawn1 })
    const p2 = new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, spawn: spawn2 })

    p1.start()
    expect(FfmpegProcess.activeCount).toBe(before + 1)
    p2.start()
    expect(FfmpegProcess.activeCount).toBe(before + 2)

    proc1.emit('close', 0)
    expect(FfmpegProcess.activeCount).toBe(before + 1)
    p2.stop()
    proc2.emit('close', null)
    expect(FfmpegProcess.activeCount).toBe(before)
  })
})
