import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { chooseEncoder, probeFfmpeg } from '../src/protect/ffmpeg.js'

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
