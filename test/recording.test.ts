import type { CameraRecordingConfiguration, RecordingPacket } from 'homebridge'
import type { QualityPreference } from '../src/accessories/quality.js'
import type { FfmpegCapabilities, SpawnFn } from '../src/protect/ffmpeg.js'
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_RESTARTS, PREBUFFER_FRAGMENTS, PrebufferRing, recordingArgs, RecordingDelegate, RESTART_DELAY_MS } from '../src/accessories/recording.js'
import { FfmpegProcess } from '../src/protect/ffmpeg.js'

// setTimeout only: `flush` below rides on setImmediate, and faking that would
// hang every await in this file.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('prebufferRing', () => {
  it('drops the oldest past the cap', () => {
    const ring = new PrebufferRing()
    ring.accept('init', Buffer.from('I'))
    for (let i = 0; i < PREBUFFER_FRAGMENTS + 4; i++)
      ring.accept('fragment', Buffer.from([i]))
    const shot = ring.snapshot()!
    expect(shot.fragments).toHaveLength(PREBUFFER_FRAGMENTS)
    expect(shot.fragments[0]![0]).toBe(4)
  })

  it('has no snapshot before the init segment arrives', () => {
    const ring = new PrebufferRing()
    ring.accept('fragment', Buffer.from('f'))
    expect(ring.snapshot()).toBeUndefined()
  })

  it('keeps the init segment across a reset', () => {
    const ring = new PrebufferRing()
    ring.accept('init', Buffer.from('I'))
    ring.accept('fragment', Buffer.from('f'))
    ring.reset()
    const shot = ring.snapshot()!
    expect(shot.init.toString()).toBe('I')
    expect(shot.fragments).toEqual([])
  })

  it('returns the init segment followed by fragments in insertion order', () => {
    const ring = new PrebufferRing()
    ring.accept('init', Buffer.from('I'))
    ring.accept('fragment', Buffer.from('a'))
    ring.accept('fragment', Buffer.from('b'))
    const shot = ring.snapshot()!
    expect(shot.init.toString()).toBe('I')
    expect(shot.fragments.map(f => f.toString())).toEqual(['a', 'b'])
  })

  it('replaces the init segment when a new one arrives', () => {
    const ring = new PrebufferRing()
    ring.accept('init', Buffer.from('I'))
    ring.accept('init', Buffer.from('J'))
    const shot = ring.snapshot()!
    expect(shot.init.toString()).toBe('J')
  })

  it('does not let snapshot mutations leak back into the ring', () => {
    const ring = new PrebufferRing()
    ring.accept('init', Buffer.from('I'))
    ring.accept('fragment', Buffer.from('a'))
    const shot = ring.snapshot()!
    shot.fragments.push(Buffer.from('z'))
    expect(ring.snapshot()!.fragments).toHaveLength(1)
  })
})

const SECRET = 'SENTINEL-TOKEN-DO-NOT-LOG'
const URL = `rtsps://192.0.2.1:7441/live?token=${SECRET}`
const caps: FfmpegCapabilities = { path: '/usr/bin/ffmpeg', encoder: 'h264_vaapi', hwaccel: 'vaapi' }

/** A minimal ISO-BMFF box, which is all Fmp4Splitter reads. */
function box(type: string, payload = ''): Buffer {
  const body = Buffer.from(payload, 'latin1')
  const buf = Buffer.alloc(8 + body.length)
  buf.writeUInt32BE(buf.length, 0)
  buf.write(type, 4, 'latin1')
  body.copy(buf, 8)
  return buf
}

const init = (marker: string) => Buffer.concat([box('ftyp', marker), box('moov')])
const fragment = (marker: string) => Buffer.concat([box('moof'), box('mdat', marker)])

function fakeSpawn() {
  const proc = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    stdout: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() }),
    kill: vi.fn(() => true),
    killed: false,
  })
  const spawn: SpawnFn = vi.fn(() => proc as unknown as ReturnType<SpawnFn>)
  return { proc, spawn }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

function harness(options: { audio?: boolean, url?: () => Promise<string>, quality?: () => QualityPreference } = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  const { proc, spawn } = fakeSpawn()
  const get = vi.fn(options.url ?? (async () => URL))
  const delegate = new RecordingDelegate({
    deviceId: 'cam-1',
    label: 'Front Door',
    log,
    urls: { get },
    caps,
    audioActive: () => options.audio ?? true,
    quality: options.quality,
    spawn,
  })
  return {
    delegate,
    ring: delegate.ring,
    log,
    proc,
    spawn: spawn as ReturnType<typeof vi.fn>,
    get,
    close: (id: number) => delegate.closeRecordingStream(id),
    /** Starts the encoder and waits for the stream-url await to settle. */
    start: async () => {
      delegate.updateRecordingActive(true)
      await flush()
    },
    args: () => (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string[],
  }
}

async function take(gen: AsyncGenerator<RecordingPacket>, n: number): Promise<RecordingPacket[]> {
  const out: RecordingPacket[] = []
  for (let i = 0; i < n; i++) {
    const next = await gen.next()
    if (next.done)
      break
    out.push(next.value)
  }
  return out
}

async function drain(gen: AsyncGenerator<RecordingPacket>): Promise<RecordingPacket[]> {
  const out: RecordingPacket[] = []
  for await (const packet of gen)
    out.push(packet)
  return out
}

function configuration(fragmentLength: number, width = 1920, height = 1080): CameraRecordingConfiguration {
  return {
    prebufferLength: 4000,
    eventTriggerTypes: [],
    mediaContainerConfiguration: { fragmentLength },
    videoCodec: { resolution: [width, height, 30] },
    audioCodec: {},
  } as unknown as CameraRecordingConfiguration
}

describe('recordingArgs', () => {
  it('drops audio when RecordingAudioActive is false', () => {
    expect(recordingArgs(caps, { url: URL, audio: false, fragmentMs: 4000 })).toContain('-an')
  })

  it('encodes aac when audio is active, and never opus, which hksv forbids', () => {
    const args = recordingArgs(caps, { url: URL, audio: true, fragmentMs: 4000 })
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac')
    expect(args.join(' ')).not.toContain('libopus')
    expect(args).not.toContain('-an')
  })

  it('encodes video with the probed hardware encoder', () => {
    const args = recordingArgs(caps, { url: URL, audio: true, fragmentMs: 4000 })
    expect(args[args.indexOf('-c:v') + 1]).toBe('h264_vaapi')
  })

  it('puts every output option before the output url, where ffmpeg still reads them', () => {
    const args = recordingArgs(caps, { url: URL, audio: true, fragmentMs: 4000 })
    const output = args.indexOf('pipe:1')
    expect(output).toBe(args.length - 1)
    for (const option of ['-c:v', '-c:a', '-f', '-movflags', '-frag_duration', '-b:v'])
      expect(args.indexOf(option)).toBeLessThan(output)
  })

  it('puts the hwaccel options before the input, where ffmpeg still reads them', () => {
    const args = recordingArgs(caps, { url: URL, audio: true, fragmentMs: 4000 })
    expect(args.indexOf('-hwaccel')).toBeLessThan(args.indexOf('-i'))
    expect(args.indexOf('-hwaccel_output_format')).toBeLessThan(args.indexOf('-i'))
    expect(args[args.indexOf('-i') + 1]).toBe(URL)
  })

  it('omits the hwaccel options on the software encoder', () => {
    const args = recordingArgs({ path: '/usr/bin/ffmpeg', encoder: 'libx264' }, { url: URL, audio: true, fragmentMs: 4000 })
    expect(args).not.toContain('-hwaccel')
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264')
  })

  it('fragments the mp4 at the negotiated length, in microseconds', () => {
    const args = recordingArgs(caps, { url: URL, audio: true, fragmentMs: 4000 })
    expect(args[args.indexOf('-frag_duration') + 1]).toBe('4000000')
    expect(args[args.indexOf('-movflags') + 1]).toBe('frag_keyframe+empty_moov+default_base_moof')
  })
})

describe('recordingDelegate stream generator', () => {
  it('yields the init segment before any fragment', async () => {
    const { delegate, ring, close } = harness()
    ring.accept('init', Buffer.from('I'))
    ring.accept('fragment', Buffer.from('f1'))
    const gen = delegate.handleRecordingStreamRequest(1)
    // One packet is held back until it is known whether another follows, so the
    // close is what releases the final one.
    const packets = take(gen, 3)
    await flush()
    close(1)
    expect((await packets).map(p => p.data.toString())).toEqual(['I', 'f1'])
  })

  it('marks only the final packet as last', async () => {
    const { delegate, ring, close } = harness()
    ring.accept('init', Buffer.from('I'))
    ring.accept('fragment', Buffer.from('f1'))
    const gen = delegate.handleRecordingStreamRequest(1)
    const first = await gen.next()
    expect(first.value!.isLast).toBe(false)
    close(1)
    const rest = await drain(gen)
    expect(rest.map(p => p.data.toString())).toEqual(['f1'])
    expect(rest.at(-1)!.isLast).toBe(true)
  })

  // Without a wake in closeRecordingStream the generator stays parked on a
  // promise nothing will ever resolve: the stream entry leaks and HAP waits for
  // a `return` that never comes. Isolated on purpose — every other close in
  // these tests happens with a fragment still queued, so none of them reaches
  // the parked path.
  //
  // `.done` alone passed over the real defect: hap-nodejs has no way to tell the
  // controller a clip ended unless some packet carries isLast, so what matters
  // is that the LAST packet is flagged, not merely that the generator finished.
  it('finishes a generator that is parked with an empty queue by flagging its last packet', async () => {
    const { delegate, ring, close } = harness()
    ring.accept('init', Buffer.from('I'))
    const gen = delegate.handleRecordingStreamRequest(1)
    const pending = gen.next()
    await flush()
    close(1)
    const packet = await pending
    expect(packet.value!.data.toString()).toBe('I')
    expect(packet.value!.isLast).toBe(true)
    expect((await gen.next()).done).toBe(true)
  })

  it('flags the last packet even when the stream closes after live fragments have been sent', async () => {
    const h = await harnessStarted()
    h.proc.stdout.emit('data', init('one'))
    const gen = h.delegate.handleRecordingStreamRequest(1)
    const packets: RecordingPacket[] = []
    const done = (async () => {
      for await (const packet of gen) packets.push(packet)
    })()
    await flush()
    h.proc.stdout.emit('data', fragment('a'))
    await flush()
    h.close(1)
    await done
    expect(packets.map(p => p.isLast)).toEqual([false, true])
    expect(packets.at(-1)!.data.toString('latin1')).toContain('a')
  })

  it('yields fragments that arrive live, after the prebuffer is exhausted', async () => {
    const h = await harnessStarted()
    h.proc.stdout.emit('data', init('one'))
    const gen = h.delegate.handleRecordingStreamRequest(1)
    // Parked: the prebuffer held no fragments, so the init segment cannot be
    // yielded until something tells the generator whether more follows.
    const pending = gen.next()
    await flush()
    h.proc.stdout.emit('data', fragment('live'))
    const first = await pending
    expect(first.value!.data.toString('latin1')).toContain('one')
    expect(first.value!.isLast).toBe(false)

    const second = gen.next()
    await flush()
    h.proc.stdout.emit('data', fragment('later'))
    const packet = await second
    expect(packet.value!.data.toString('latin1')).toContain('live')
    expect(packet.value!.isLast).toBe(false)
  })

  it('yields nothing when no init segment has been produced yet', async () => {
    const { delegate, log } = harness()
    expect(await drain(delegate.handleRecordingStreamRequest(1))).toEqual([])
    expect(log.warn.mock.calls.some(([m]) => (m as string).includes('init segment'))).toBe(true)
  })

  it('logs the start of a recording with the camera label, and the fragment count on close', async () => {
    const { delegate, ring, log, close } = harness()
    ring.accept('init', Buffer.from('I'))
    ring.accept('fragment', Buffer.from('f1'))
    const gen = delegate.handleRecordingStreamRequest(1)
    await gen.next()
    expect(log.info.mock.calls.some(([m]) => (m as string).includes('Recording started for "Front Door"'))).toBe(true)
    close(1)
    await drain(gen)
    expect(log.info.mock.calls.some(([m]) => (m as string) === 'Recording for "Front Door" ended after 1 fragments.')).toBe(true)
  })

  it('never puts the stream url in a log line', async () => {
    const h = harness()
    await h.start()
    h.ring.accept('init', Buffer.from('I'))
    const gen = h.delegate.handleRecordingStreamRequest(1)
    const drained = drain(gen)
    await flush()
    h.close(1)
    await drained
    const logged = [...h.log.info.mock.calls, ...h.log.warn.mock.calls, ...h.log.debug.mock.calls].flat().join(' ')
    expect(logged).not.toContain(SECRET)
  })
})

describe('recordingDelegate encoder', () => {
  it('starts the encoder when recording becomes active and stops it when it does not', async () => {
    const h = await harnessStarted()
    expect(h.delegate.encoding).toBe(true)
    h.delegate.updateRecordingActive(false)
    expect(h.proc.kill).toHaveBeenCalledWith('SIGKILL')
    expect(h.delegate.encoding).toBe(false)
  })

  it('does not spawn a second encoder while one is running', async () => {
    const h = await harnessStarted()
    await h.start()
    expect(h.spawn).toHaveBeenCalledTimes(1)
  })

  it('does not spawn at all if recording was switched off while the url was being fetched', async () => {
    let release: (url: string) => void = () => {}
    const h = harness({ url: () => new Promise<string>((resolve) => {
      release = resolve
    }) })
    h.delegate.updateRecordingActive(true)
    h.delegate.updateRecordingActive(false)
    release(URL)
    await flush()
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('redacts the stream url out of an encoder start failure', async () => {
    const h = harness({ url: async () => {
      throw new Error(`connect failed for ${URL}`)
    } })
    await h.start()
    const warned = h.log.warn.mock.calls.flat().join(' ')
    expect(warned).not.toContain(SECRET)
    expect(warned).toContain('Front Door')
  })

  it('carries the fragment length HomeKit selected into the encoder arguments', async () => {
    const h = harness()
    h.delegate.updateRecordingConfiguration(configuration(8000))
    await h.start()
    const args = h.args()
    expect(args[args.indexOf('-frag_duration') + 1]).toBe('8000000')
  })

  it('tolerates a configuration before any session, and stores it', () => {
    const { delegate } = harness()
    expect(delegate.configuration).toBeUndefined()
    const config = configuration(4000)
    delegate.updateRecordingConfiguration(config)
    expect(delegate.configuration).toBe(config)
    delegate.updateRecordingConfiguration(undefined)
    expect(delegate.configuration).toBeUndefined()
  })

  it('drops audio from the encoder when RecordingAudioActive is false', async () => {
    const h = harness({ audio: false })
    await h.start()
    expect(h.args()).toContain('-an')
  })

  it('keeps the encoder running when a recording stream closes, or the next event has no prebuffer', async () => {
    const h = await harnessStarted()
    h.ring.accept('init', Buffer.from('I'))
    const gen = h.delegate.handleRecordingStreamRequest(1)
    const drained = drain(gen)
    await flush()
    h.close(1)
    await drained
    expect(h.proc.kill).not.toHaveBeenCalled()
    expect(h.delegate.encoding).toBe(true)
  })

  it('feeds split fmp4 pieces from stdout into the ring', async () => {
    const h = await harnessStarted()
    h.proc.stdout.emit('data', init('one'))
    h.proc.stdout.emit('data', fragment('a'))
    const shot = h.ring.snapshot()!
    expect(shot.init.toString('latin1')).toContain('one')
    expect(shot.fragments).toHaveLength(1)
  })

  it('drops fragments buffered against a previous init segment when the encoder restarts', async () => {
    const h = await harnessStarted()
    h.proc.stdout.emit('data', init('one'))
    h.proc.stdout.emit('data', fragment('a'))
    h.proc.stdout.emit('data', fragment('b'))
    expect(h.ring.snapshot()!.fragments).toHaveLength(2)

    // A second init means a restarted encoder: everything above was encoded
    // against the init HomeKit will NOT be given.
    h.proc.stdout.emit('data', init('two'))
    const shot = h.ring.snapshot()!
    expect(shot.init.toString('latin1')).toContain('two')
    expect(shot.fragments).toEqual([])

    // And the fragments that follow the new init are kept.
    h.proc.stdout.emit('data', fragment('c'))
    expect(h.ring.snapshot()!.fragments.map(f => f.toString('latin1').slice(-1))).toEqual(['c'])
  })

  // FfmpegProcess.activeCount IS the host-wide live-view cap (default 6 on
  // hardware, 2 on software). A recorder is not an interactive viewer, and six
  // recording cameras counting towards it would refuse every live view.
  it('does not consume a live-view slot while recording', async () => {
    const before = FfmpegProcess.activeCount
    const h = await harnessStarted()
    expect(h.delegate.encoding).toBe(true)
    expect(FfmpegProcess.activeCount).toBe(before)
  })

  // A kill that was not delivered leaves an orphan: it still runs, and if the
  // handle were dropped `encoding` would report false and the next start would
  // spawn a SECOND encoder against the same camera.
  it('keeps a process whose kill failed, and refuses to spawn a second for it', async () => {
    const h = await harnessStarted()
    h.proc.kill.mockReturnValue(false)
    h.delegate.updateRecordingActive(false)
    expect(h.delegate.encoding).toBe(true)
    h.delegate.updateRecordingActive(true)
    await flush()
    expect(h.spawn).toHaveBeenCalledTimes(1)
    // And a later stop retries the kill rather than assuming it worked.
    h.proc.kill.mockReturnValue(true)
    h.delegate.updateRecordingActive(false)
    expect(h.proc.kill).toHaveBeenCalledTimes(2)
    expect(h.delegate.encoding).toBe(false)
  })

  it('ends every open recording stream when the encoder stops', async () => {
    const h = await harnessStarted()
    h.proc.stdout.emit('data', init('one'))
    const gen = h.delegate.handleRecordingStreamRequest(1)
    const packets: RecordingPacket[] = []
    const done = (async () => {
      for await (const packet of gen)
        packets.push(packet)
    })()
    await flush()
    h.delegate.updateRecordingActive(false)
    await done
    expect(packets.at(-1)!.isLast).toBe(true)
  })

  it('clears buffered fragments when the encoder exits, so the next clip is not served from a dead one', async () => {
    const h = await harnessStarted()
    h.proc.stdout.emit('data', init('one'))
    h.proc.stdout.emit('data', fragment('a'))
    h.proc.emit('close', 0)
    expect(h.ring.snapshot()!.fragments).toEqual([])
  })

  it('ends a clip whose consumer falls more than the prebuffer depth behind, rather than queueing without limit', async () => {
    const h = await harnessStarted()
    h.proc.stdout.emit('data', init('one'))
    const gen = h.delegate.handleRecordingStreamRequest(1)
    for (let i = 0; i < PREBUFFER_FRAGMENTS + 5; i++)
      h.proc.stdout.emit('data', fragment(`f${i}`))
    const packets = await drain(gen)
    expect(packets).toHaveLength(PREBUFFER_FRAGMENTS + 1)
    expect(packets.at(-1)!.isLast).toBe(true)
    expect(h.log.warn.mock.calls.flat().join(' ')).toContain('fragments behind')
  })

  it('logs a clean exit, which ffmpeg itself never reports', async () => {
    const h = await harnessStarted()
    h.proc.emit('close', 0)
    expect(h.delegate.encoding).toBe(false)
    expect(h.log.info.mock.calls.flat().join(' ')).toContain('Recording prebuffer for "Front Door" stopped')
  })

  it('restarts an encoder that exited while recording is still active', async () => {
    const h = await harnessStarted()
    h.proc.emit('close', 0)
    expect(h.spawn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
    await flush()
    expect(h.spawn).toHaveBeenCalledTimes(2)
    expect(h.delegate.encoding).toBe(true)
  })

  it('does not restart an encoder that stopped because recording was switched off', async () => {
    const h = await harnessStarted()
    h.delegate.updateRecordingActive(false)
    h.proc.emit('close', 0)
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
    await flush()
    expect(h.spawn).toHaveBeenCalledTimes(1)
    // No restart was even attempted: startEncoder re-checks `active` after its
    // await, so counting spawns alone would pass with the restart scheduled.
    // A second stream-url fetch is what proves the retry was never begun.
    expect(h.get).toHaveBeenCalledTimes(1)
  })

  it('gives up after repeated short-lived runs instead of respawning forever', async () => {
    const h = await harnessStarted()
    for (let i = 0; i <= MAX_RESTARTS; i++) {
      h.proc.emit('close', 1)
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
      await flush()
    }
    expect(h.spawn).toHaveBeenCalledTimes(MAX_RESTARTS + 1)
    expect(h.log.warn.mock.calls.flat().join(' ')).toContain('Giving up')
  })

  it('honours the configured quality preference, which live view already does', async () => {
    const h = harness({ quality: () => 'low' })
    h.delegate.updateRecordingConfiguration(configuration(4000))
    await h.start()
    expect(h.get).toHaveBeenCalledWith('cam-1', 'low')
  })

  it('falls back to the requested resolution when the preference is auto', async () => {
    const h = harness({ quality: () => 'auto' })
    h.delegate.updateRecordingConfiguration(configuration(4000, 1280, 720))
    await h.start()
    expect(h.get).toHaveBeenCalledWith('cam-1', 'medium')
  })

  // An async generator's body does not run until the first next(), so
  // registering the stream inside one loses every fragment produced between the
  // request and HAP's first pull.
  it('keeps fragments produced before HomeKit first pulls from the generator', async () => {
    const h = await harnessStarted()
    h.proc.stdout.emit('data', init('one'))
    const gen = h.delegate.handleRecordingStreamRequest(1)
    h.proc.stdout.emit('data', fragment('early'))
    expect((await gen.next()).value!.data.toString('latin1')).toContain('one')
    const pending = gen.next()
    await flush()
    h.close(1)
    expect((await pending).value!.data.toString('latin1')).toContain('early')
  })

  it('stops the encoder when stdout stops being parsable', async () => {
    const h = await harnessStarted()
    const corrupt = Buffer.alloc(8)
    corrupt.writeUInt32BE(2, 0)
    h.proc.stdout.emit('data', corrupt)
    expect(h.proc.kill).toHaveBeenCalledWith('SIGKILL')
    expect(h.log.warn.mock.calls.flat().join(' ')).toContain('unreadable')
  })
})

async function harnessStarted(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options)
  await h.start()
  return h
}
