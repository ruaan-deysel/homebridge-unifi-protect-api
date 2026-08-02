import type { SpawnFn } from '../src/protect/ffmpeg.js'
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { inspect } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { encoderCandidates, FfmpegProcess, probeFfmpeg, redactStreamUrls, splitOnLastToken } from '../src/protect/ffmpeg.js'

const fixture = (n: string) => JSON.parse(readFileSync(`test/fixtures/ffmpeg/${n}.json`, 'utf8'))

describe('encoderCandidates', () => {
  // The real hardware build lists BOTH. Offering only the first preference is
  // what sent the reference console to software when its QSV trial failed.
  it('offers every encoder the real hardware build claims, best first, software last', () => {
    const { hwaccels, encoders } = fixture('hardware')
    expect(encoderCandidates(hwaccels, encoders)).toEqual([
      { encoder: 'h264_qsv', hwaccel: 'qsv' },
      { encoder: 'h264_vaapi', hwaccel: 'vaapi' },
      { encoder: 'libx264' },
    ])
  })

  it('offers libx264 alone on the real software-only build', () => {
    const { hwaccels, encoders } = fixture('software')
    expect(encoderCandidates(hwaccels, encoders)).toEqual([{ encoder: 'libx264' }])
  })

  it('drops qsv when the build cannot do it at all', () => {
    const { encoders } = fixture('hardware')
    expect(encoderCandidates('vaapi\ndrm\n', encoders)).toEqual([
      { encoder: 'h264_vaapi', hwaccel: 'vaapi' },
      { encoder: 'libx264' },
    ])
  })

  // The fixture must be able to DEFEAT the mutation its comment names: a plain
  // `encoders.includes('h264_qsv')` has to pass on this string while the real
  // anchored match fails. So `h264_qsv` appears here in a description column,
  // exactly as ffmpeg prints alternatives, and nowhere in an encoder column.
  it('does not mistake an h264_qsv mentioned in a description for an h264_qsv encoder', () => {
    const encoders = ' V..... hevc_qsv HEVC (Intel Quick Sync) (alternatives: h264_qsv)\n V....D libx264 libx264 H.264\n'
    expect(encoders).toContain('h264_qsv')
    expect(encoderCandidates('qsv\n', encoders)).toEqual([{ encoder: 'libx264' }])
  })

  // Synthetic: none of the real fixtures contain an encoder name that is a
  // *prefix* of a longer one, so the tests above pass even without the `\b`
  // boundary in hasEncoder. This one exercises that boundary directly.
  it('does not mistake h264_qsv_backup for h264_qsv (synthetic)', () => {
    expect(encoderCandidates('qsv\n', ' V..... h264_qsv_backup Some experimental variant\n V....D libx264 libx264 H.264\n'))
      .toEqual([{ encoder: 'libx264' }])
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

  /**
   * The reference console, measured 2026-08-01 (i7-8700K / UHD 630, i915,
   * /dev/dri/renderD128 present). `/usr/bin/ffmpeg` LISTS both encoders, but:
   *
   *   QSV   -> Device creation failed: -1313558101
   *            Failed to set value 'qsv=hw' for option 'init_hw_device'
   *   VAAPI -> encodes 3 frames, exits clean
   *
   * QSV wins the preference order, so demoting straight to software on its
   * failure put this exact host on libx264: ~2.5 cores per stream instead of
   * ~0.09, and a concurrency cap of two instead of six.
   */
  it('falls through to vaapi when the qsv trial fails, rather than demoting to software', async () => {
    const hw = fixture('hardware')
    const run = vi.fn(async (_path: string, args: string[]) => {
      if (args.includes('h264_qsv'))
        throw new Error('Device creation failed: -1313558101')
      if (args.includes('h264_vaapi'))
        return ''
      return args.includes('-hwaccels') ? hw.hwaccels : hw.encoders
    })
    const caps = await probeFfmpeg({ log, run, candidates: ['/usr/bin/ffmpeg'] })
    expect(caps).toEqual({ path: '/usr/bin/ffmpeg', encoder: 'h264_vaapi', hwaccel: 'vaapi' })
  })

  it('demotes to software only when every listed hardware encoder fails its trial', async () => {
    const hw = fixture('hardware')
    const run = vi.fn(async (_path: string, args: string[]) => {
      if (args.includes('-c:v'))
        throw new Error('Device creation failed: -22')
      return args.includes('-hwaccels') ? hw.hwaccels : hw.encoders
    })
    const caps = await probeFfmpeg({ log, run, candidates: ['/usr/bin/ffmpeg'] })
    expect(caps).toEqual({ path: '/usr/bin/ffmpeg', encoder: 'libx264' })
    // Both were tried, not just the first.
    expect(run.mock.calls.filter(([, args]) => args.includes('h264_qsv'))).toHaveLength(1)
    expect(run.mock.calls.filter(([, args]) => args.includes('h264_vaapi'))).toHaveLength(1)
  })

  it('stops at the first encoder that works, without trialling the rest', async () => {
    const hw = fixture('hardware')
    const run = vi.fn(async (_path: string, args: string[]) =>
      args.includes('-hwaccels') ? hw.hwaccels : hw.encoders)
    const caps = await probeFfmpeg({ log, run, candidates: ['/usr/bin/ffmpeg'] })
    expect(caps.encoder).toBe('h264_qsv')
    expect(run.mock.calls.filter(([, args]) => args.includes('h264_vaapi'))).toHaveLength(0)
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
    stdout: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() }),
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

  it('redacts srtp key parameters', () => {
    const line = '-srtp_out_params AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA== -f rtp'
    expect(redactStreamUrls(line)).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==')
    expect(redactStreamUrls(line)).toContain('-srtp_out_params')
  })

  it('redacts inbound srtp key parameters', () => {
    const line = '-srtp_in_params SECRETKEYSECRETKEYSECRETKEY== -i srtp://127.0.0.1:5000'
    expect(redactStreamUrls(line)).not.toContain('SECRETKEYSECRETKEYSECRETKEY==')
  })

  // The form the TALKBACK key actually travels in. That path emits no
  // -srtp_in_params/-srtp_out_params at all: the key is on the `a=crypto` line
  // of an SDP fed on stdin, and ffmpeg echoes the offending SDP line back on
  // stderr when it cannot parse it — straight into a warn on a non-zero exit.
  it('redacts the srtp key on an echoed sdp crypto line', () => {
    const line = 'Failed to parse: a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:U0VDUkVUS0VZU0VDUkVUU0FMVA=='
    const out = redactStreamUrls(line)
    expect(out).not.toContain('U0VDUkVUS0VZU0VDUkVUU0FMVA==')
    expect(out).toContain('inline:<srtp-key-redacted>')
    // The rest of the diagnostic survives, or the line explains nothing.
    expect(out).toContain('AES_CM_128_HMAC_SHA1_80')
  })

  it('still redacts stream urls', () => {
    expect(redactStreamUrls('rtsps://host:7441/token')).toBe('<stream-url-redacted>')
  })
})

// The structural half of the redaction fix: redaction only ever runs on whole
// whitespace-delimited tokens, so a URL cut anywhere by a chunk boundary is
// still one token when it is matched. Asserted on VALUES, not on the log line —
// the log-line tests below cannot tell a correct split from a lucky one.
describe('splitOnLastToken', () => {
  it('holds back the unterminated tail and releases everything before it', () => {
    expect(splitOnLastToken('opening rtsps://host/a?token=abc')).toEqual({
      complete: 'opening ',
      pending: 'rtsps://host/a?token=abc',
    })
  })

  it('holds nothing back once the token is terminated', () => {
    expect(splitOnLastToken('opening rtsps://host/a?token=abc\n')).toEqual({
      complete: 'opening rtsps://host/a?token=abc\n',
      pending: '',
    })
  })

  it('treats every kind of whitespace as a terminator', () => {
    expect(splitOnLastToken('a\tb').pending).toBe('b')
    expect(splitOnLastToken('a\r\nb').pending).toBe('b')
    expect(splitOnLastToken('a b ').pending).toBe('')
  })

  // The tail is held until it completes, so it has to be bounded or it is an
  // unbounded buffer on a process that can emit megabytes.
  it('drops a tail past the limit instead of holding it forever', () => {
    expect(splitOnLastToken('x'.repeat(4097), 4096).pending).toBe('')
    expect(splitOnLastToken('x'.repeat(4096), 4096).pending).toHaveLength(4096)
    // The default bound is the one FfmpegProcess actually runs with.
    expect(splitOnLastToken('x'.repeat(100_000)).pending).toBe('')
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

  // The third distinct shape of this leak on this branch. Per-chunk redaction
  // fixed truncate-then-redact but could never match a URL whose `rtsps://`
  // arrives in one `data` event and whose token arrives in the next — which is
  // simply what a pipe does to a long line.
  it('redacts a url whose scheme and token arrive in separate data events', () => {
    log.warn.mockClear()
    const { proc, spawn } = fakeSpawn()
    const p = new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, spawn })
    p.start()

    // Split inside the scheme AND inside the token: two boundaries, one URL.
    proc.stderr.emit('data', Buffer.from('Error opening input rtsp'))
    proc.stderr.emit('data', Buffer.from('s://192.0.2.1:7441/live?token=SENTINEL-'))
    proc.stderr.emit('data', Buffer.from('TOKEN-DO-NOT-LOG failed\n'))
    proc.emit('close', 1)

    expect(log.warn).toHaveBeenCalledTimes(1)
    const message = log.warn.mock.calls[0]?.[0] as string
    // Positive first: prove the line carries the diagnostic before proving it
    // carries no secret. An empty stderr would satisfy the negative alone.
    expect(message).toContain('ffmpeg exited with code 1')
    expect(message).toContain('Error opening input')
    expect(message).not.toContain(SECRET)
    expect(message).not.toContain('SENTINEL')
  })

  // ffmpeg's last line frequently has no trailing newline, so the token that
  // ends the stream is never terminated by whitespace at all.
  it('redacts a split url that the process never terminates with whitespace', () => {
    log.warn.mockClear()
    const { proc, spawn } = fakeSpawn()
    const p = new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, spawn })
    p.start()

    proc.stderr.emit('data', Buffer.from('opening rtsps://192.0.2.1:7441/live?token='))
    proc.stderr.emit('data', Buffer.from(SECRET))
    proc.emit('close', 1)

    expect(log.warn).toHaveBeenCalledTimes(1)
    const message = log.warn.mock.calls[0]?.[0] as string
    // The placeholder, not just the absence of the secret: a held-back tail that
    // is silently DROPPED at close would also contain no secret, while throwing
    // away the line that explains the failure.
    expect(message).toContain('opening <stream-url-redacted>')
  })

  // The sentinel: same shape as the stream-url leak test above, but for the
  // SRTP key ffmpeg echoes when talkback fails. `util.inspect` on the whole
  // captured call list is the same check that has caught a raw-error leak
  // before, so it stays the assertion even though nothing here throws.
  it('never leaks an srtp key through a failed process', () => {
    log.warn.mockClear()
    const SRTP_SECRET = 'PLANTEDSENTINELKEY=='
    const { proc, spawn } = fakeSpawn()
    const p = new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: ['-srtp_out_params', SRTP_SECRET], log, spawn })
    p.start()
    proc.stderr.emit('data', Buffer.from(`-srtp_out_params ${SRTP_SECRET} -f rtp\n`))
    proc.emit('close', 1)

    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0]?.[0]).toContain('ffmpeg exited with code 1')

    const logged = inspect(log.warn.mock.calls, { depth: 10 })
    expect(logged).not.toContain(SRTP_SECRET)
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

  // The return value is how the caller learns it is holding an orphan: false
  // means the process is still running and must stay tracked for a retry.
  it('stop() reports whether the kill actually landed', () => {
    const { proc, spawn } = fakeSpawn()
    proc.kill.mockReturnValueOnce(false)
    const p = new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, spawn })
    p.start()

    expect(p.stop()).toBe(false)
    // Still running, so it still holds its slot — the count must not have moved.
    expect(p.running).toBe(true)
    expect(p.stop()).toBe(true)

    proc.emit('close', null)
  })

  // Nothing left to kill: a process that already exited needs no retry, and
  // reporting false for it would keep a corpse in the caller's map forever.
  it('stop() reports success for a process that already exited, and for one never started', () => {
    const { proc, spawn } = fakeSpawn()
    const p = new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, spawn })
    p.start()
    proc.emit('close', 0)
    proc.kill.mockReturnValue(false)

    expect(p.stop()).toBe(true)
    expect(proc.kill).not.toHaveBeenCalled()

    expect(new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, spawn }).stop()).toBe(true)
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

  it('writes the stdin payload and ends the stream', () => {
    const { proc, spawn } = fakeSpawn()
    new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, spawn, stdin: 'v=0\r\n' }).start()
    expect(proc.stdin.write).toHaveBeenCalledExactlyOnceWith('v=0\r\n')
    expect(proc.stdin.end).toHaveBeenCalledOnce()
  })

  it('leaves stdin alone when no payload is given', () => {
    const { proc, spawn } = fakeSpawn()
    new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, spawn }).start()
    expect(proc.stdin.write).not.toHaveBeenCalled()
    expect(proc.stdin.end).not.toHaveBeenCalled()
  })

  it('delivers stdout chunks in order', () => {
    const seen: string[] = []
    const { proc, spawn } = fakeSpawn()
    new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, onStdout: c => seen.push(c.toString()), spawn }).start()
    proc.stdout.emit('data', Buffer.from('a'))
    proc.stdout.emit('data', Buffer.from('b'))
    expect(seen).toEqual(['a', 'b'])
  })

  it('does not read stdout when no consumer is given', () => {
    const { proc, spawn } = fakeSpawn()
    new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, spawn }).start()
    expect(proc.stdout.listenerCount('data')).toBe(0)
  })

  it('does not throw when the child has no stdout stream', () => {
    const { proc, spawn } = fakeSpawn()
    // @ts-expect-error simulating a ChildProcess whose stdout is null, as Node's types allow
    proc.stdout = undefined
    expect(() => new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, onStdout: () => {}, spawn }).start()).not.toThrow()
  })

  it('does not throw when the child has no stdin stream', () => {
    const { proc, spawn } = fakeSpawn()
    // @ts-expect-error simulating a ChildProcess whose stdin is null, as Node's types allow
    proc.stdin = undefined
    expect(() => new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, spawn, stdin: 'v=0\r\n' }).start()).not.toThrow()
  })

  // Node's EventEmitter treats 'error' specially: emitting it with zero
  // listeners throws synchronously, which is exactly how an unhandled EPIPE
  // on child.stdin would crash the host Homebridge process. Emitting through
  // the real EventEmitter (not a spy) is what makes this test fail honestly
  // without the fix, rather than merely checking a listener was registered.
  it('does not crash when child.stdin emits an error (e.g. EPIPE from a dead process)', () => {
    const { proc, spawn } = fakeSpawn()
    const p = new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, spawn, stdin: 'v=0\r\n' })
    p.start()
    expect(() => proc.stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }))).not.toThrow()
  })
})
