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

  // Synthetic: none of the real fixtures contain an encoder name that is a
  // *prefix* of a longer one, so the tests above pass even without the `\b`
  // boundary in hasEncoder. This one exercises that boundary directly.
  it('does not mistake h264_qsv_backup for h264_qsv (synthetic)', () => {
    expect(chooseEncoder('qsv\n', ' V..... h264_qsv_backup Some experimental variant\n V....D libx264 libx264 H.264\n'))
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
    // Real child.kill() returns true once the signal was actually delivered.
    kill: vi.fn(() => true),
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

    // Positive assertion first: the vacuous-pass hole is that "no secret
    // present" is trivially true of an empty call list. Prove the warning
    // actually fired before proving it is clean.
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0]?.[0]).toContain('ffmpeg exited with code 1')

    const logged = inspect(log.warn.mock.calls, { depth: 10 })
    expect(logged).not.toContain(SECRET)
    expect(log.warn.mock.calls.flat().every(a => typeof a === 'string')).toBe(true)
  })

  it('redacts a chunk before truncation, so a scheme cut off by the 4000-char bound cannot leak a token', () => {
    log.warn.mockClear()
    const { proc, spawn } = fakeSpawn()
    const p = new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, spawn })
    p.start()

    // Pad past the buffer's 4000-char bound so a naive "append then slice"
    // would cut the `rtsps://` scheme off the URL, leaving redactStreamUrls
    // (which only matches an intact scheme) nothing to match.
    const padding = 'x'.repeat(4000)
    proc.stderr.emit('data', Buffer.from(`${padding}${URL}\n`))
    proc.emit('close', 1)

    expect(log.warn).toHaveBeenCalledTimes(1)
    const logged = inspect(log.warn.mock.calls, { depth: 10 })
    expect(logged).not.toContain(SECRET)
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

  it('start() refuses to spawn a second child on the same instance', () => {
    const { spawn } = fakeSpawn()
    const p = new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, spawn })
    p.start()
    expect(() => p.start()).toThrow(/start\(\) called twice/)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('stop() retries when the kill signal was not actually delivered, and stops retrying once it is', () => {
    const { proc, spawn } = fakeSpawn()
    proc.kill.mockReturnValueOnce(false) // first delivery fails
    const p = new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, spawn })
    p.start()
    p.stop() // fails: does not latch `killed`
    p.stop() // retries, succeeds (fakeSpawn's default kill() returns true)
    p.stop() // already killed: no further attempt
    expect(proc.kill).toHaveBeenCalledTimes(2)
  })

  it('calls onExit exactly once when a failed spawn emits error then close', () => {
    const before = FfmpegProcess.activeCount
    const onExit = vi.fn()
    const { proc, spawn } = fakeSpawn()
    const p = new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, spawn, onExit })
    p.start()
    proc.emit('error', new Error('ENOENT'))
    proc.emit('close', null)
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(FfmpegProcess.activeCount).toBe(before)
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
