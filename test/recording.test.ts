import type { CameraRecordingConfiguration, RecordingPacket } from 'homebridge'
import type { QualityPreference } from '../src/accessories/quality.js'
import type { FfmpegCapabilities, SpawnFn } from '../src/protect/ffmpeg.js'
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ADVERTISED_RECORDING_SIZE, selectQuality } from '../src/accessories/quality.js'
import { HEALTHY_RUN_MS, MAX_RESTARTS, PREBUFFER_FRAGMENTS, PrebufferRing, recordingArgs, RecordingDelegate, RESTART_DELAY_MS, SLOW_RESTART_DELAY_MS } from '../src/accessories/recording.js'
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

  it('drops the init segment on clear, unlike reset', () => {
    const ring = new PrebufferRing()
    ring.accept('init', Buffer.from('I'))
    ring.accept('fragment', Buffer.from('f'))
    ring.clear()
    expect(ring.snapshot()).toBeUndefined()
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

  // Without this a camera that stops sending mid-stream leaves ffmpeg blocked
  // in the demuxer forever: no exit, so no onExit, so scheduleRestart never
  // runs and HKSV is dead for that camera until Homebridge restarts. Verified
  // against the real ffmpeg 6.1.1 against a deaf listener - it hung until
  // killed without the option, and exited on time with it.
  it('gives the always-on input a read timeout, before -i where ffmpeg reads it', () => {
    const args = recordingArgs(caps, { url: URL, audio: true, fragmentMs: 4000 })
    expect(args).toContain('-timeout')
    const timeout = args.indexOf('-timeout')
    // Microseconds, ffmpeg's unit for this option. A value in milliseconds
    // would be a 15ms timeout and would kill every healthy stream instantly.
    expect(Number(args[timeout + 1])).toBe(15_000_000)
    // An input option: after -i it applies to the OUTPUT and the input keeps
    // waiting forever, which is silently the unfixed behaviour.
    expect(timeout).toBeLessThan(args.indexOf('-i'))
  })

  it('encodes video with the probed hardware encoder', () => {
    const args = recordingArgs(caps, { url: URL, audio: true, fragmentMs: 4000 })
    expect(args[args.indexOf('-c:v') + 1]).toBe('h264_vaapi')
  })

  it('puts every output option before the output url, where ffmpeg still reads them', () => {
    const args = recordingArgs(caps, { url: URL, audio: true, fragmentMs: 4000 })
    const output = args.indexOf('pipe:1')
    expect(output).toBe(args.length - 1)
    for (const option of ['-c:v', '-c:a', '-f', '-movflags', '-frag_duration', '-b:v']) {
      // PRESENCE first: indexOf returns -1 for an option that was deleted
      // outright, and -1 is less than every index, so the ordering assertion
      // alone passes for an option that is not there at all.
      expect(args).toContain(option)
      expect(args.indexOf(option)).toBeLessThan(output)
    }
  })

  it('puts the hwaccel options before the input, where ffmpeg still reads them', () => {
    const args = recordingArgs(caps, { url: URL, audio: true, fragmentMs: 4000 })
    // Presence first, for the same reason as above.
    expect(args).toContain('-hwaccel')
    expect(args).toContain('-hwaccel_output_format')
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

  // An EMPTY generator is not an empty clip, it is a contract violation:
  // hap-nodejs's `_startStreaming` tracks `lastFragmentWasMarkedLast` and warns
  // "Delegate finished streaming ... without setting RecordingPacket.isLast"
  // when a generator returns without it — for a state this plugin reaches at
  // every startup and every encoder restart. A zero-length final packet sends
  // nothing on the wire (hap's chunk loop is `while (offset < length)`) and
  // still ends the stream properly.
  it('ends the stream with a flagged empty packet when no init segment exists yet', async () => {
    const { delegate, log } = harness()
    const packets = await drain(delegate.handleRecordingStreamRequest(1))
    expect(packets).toHaveLength(1)
    expect(packets[0]!.isLast).toBe(true)
    expect(packets[0]!.data).toHaveLength(0)
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

  // A request landing between an exit and its restart used to succeed on the
  // DEAD encoder's init, park with nothing to wake it, and then be handed
  // fragments from the new encoder — a clip whose media does not match its own
  // init segment. With the ring cleared there is nothing to answer with, and an
  // empty clip is the honest answer when there is no encoder.
  it('answers nothing at all between an encoder exit and its restart', async () => {
    const h = await harnessStarted()
    h.proc.stdout.emit('data', init('one'))
    h.proc.stdout.emit('data', fragment('a'))
    h.proc.emit('close', 0)
    expect(h.ring.snapshot()).toBeUndefined()
    // No media, but a properly terminated stream — see the empty-packet test
    // above for why an empty generator is not an acceptable answer here.
    const packets = await drain(h.delegate.handleRecordingStreamRequest(1))
    expect(packets.map(p => [p.data.length, p.isLast])).toEqual([[0, true]])
  })

  // Never awaited: the point is what the generator YIELDS once the new encoder
  // is producing, and awaiting the drain first would let a regression be
  // "detected" by a test timeout instead of by this assertion.
  it('does not hand a stream opened before the restart the new encoder fragments', async () => {
    const h = await harnessStarted()
    h.proc.stdout.emit('data', init('one'))
    h.proc.emit('close', 0)
    const packets: RecordingPacket[] = []
    const gen = h.delegate.handleRecordingStreamRequest(1)
    void (async () => {
      for await (const packet of gen)
        packets.push(packet)
    })()
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
    await flush()
    h.proc.stdout.emit('data', init('two'))
    h.proc.stdout.emit('data', fragment('b'))
    // Two fragments, so a generator holding the dead encoder's init would have
    // released it rather than sitting on the lookahead.
    h.proc.stdout.emit('data', fragment('c'))
    await flush()
    // The empty terminator and nothing else: not one byte of the NEW encoder's
    // media reaches a stream opened against the old one.
    expect(packets.map(p => [p.data.toString('latin1'), p.isLast])).toEqual([['', true]])
    h.close(1)
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

  // Found on real hardware: the clip opened with all 16 buffered fragments —
  // ~64s of pre-roll against a negotiated prebufferLength of 4000ms — and the
  // controller closed the stream in the same second, before a single live
  // fragment. The ring HOLDS 16 as headroom; only what HomeKit asked for may
  // be sent.
  it('opens a clip with only the negotiated prebuffer, not the whole ring', async () => {
    const h = await harnessStarted()
    // 4000ms of prebuffer at a 4000ms fragment length = exactly one fragment.
    h.delegate.updateRecordingConfiguration(configuration(4000))
    h.proc.stdout.emit('data', init('one'))
    for (let i = 0; i < PREBUFFER_FRAGMENTS; i++)
      h.proc.stdout.emit('data', fragment(`old${i}`))

    const gen = h.delegate.handleRecordingStreamRequest(1)
    h.proc.stdout.emit('data', fragment('live'))
    h.close(1)
    const packets = await drain(gen)

    // init + the single newest prebuffered fragment + the live one.
    const bodies = packets.map(p => p.data.toString('latin1'))
    expect(bodies.some(b => b.includes(`old${PREBUFFER_FRAGMENTS - 1}`))).toBe(true)
    expect(bodies.some(b => b.includes('old0'))).toBe(false)
    expect(h.log.info.mock.calls.flat().join(' ')).toContain(`1 of ${PREBUFFER_FRAGMENTS} prebuffered`)
  })

  // A longer negotiated prebuffer must actually get more pre-roll, or the
  // "only what was negotiated" rule would just be a hardcoded 1.
  it('sends more pre-roll when HomeKit negotiates a longer prebuffer', async () => {
    const h = await harnessStarted()
    // 12000ms wanted at a 4000ms fragment length = three fragments.
    h.delegate.updateRecordingConfiguration(configuration(4000))
    ;(h.delegate as unknown as { config: { prebufferLength: number } }).config.prebufferLength = 12_000
    h.proc.stdout.emit('data', init('one'))
    for (let i = 0; i < PREBUFFER_FRAGMENTS; i++)
      h.proc.stdout.emit('data', fragment(`old${i}`))

    h.delegate.handleRecordingStreamRequest(1)
    expect(h.log.info.mock.calls.flat().join(' ')).toContain(`3 of ${PREBUFFER_FRAGMENTS} prebuffered`)
    h.close(1)
  })

  // Observed live: "Garage" started its encoder before HomeKit sent a
  // configuration and recorded on the HIGH substream - 2688x1512 - while
  // recordingOptions advertises only 1280x720. recordingArgs applies no scale
  // filter, so the fallback has to be the advertised size or the plugin ships
  // four times the pixels it promised, and pays the GPU for them.
  it('falls back to the advertised size, not the high substream, before HomeKit configures it', async () => {
    const h = await harnessStarted()

    expect(h.get).toHaveBeenCalledWith('cam-1', selectQuality(...ADVERTISED_RECORDING_SIZE))
    expect(h.log.info.mock.calls.flat().join(' ')).toContain('medium substream')
  })

  // `??` passes 0 and NaN through, and both silently restore the whole-ring
  // bug: 0 divides to Infinity, and slice(-NaN) is slice(0). The configuration
  // arrives from a controller, so it is not this plugin's to trust.
  it.each([
    ['a zero fragment length', 0],
    ['a NaN fragment length', Number.NaN],
    ['a negative fragment length', -4000],
  ])('does not send the whole ring on %s', async (_label, fragmentLength) => {
    const h = await harnessStarted()
    h.delegate.updateRecordingConfiguration(configuration(fragmentLength as number))
    h.proc.stdout.emit('data', init('one'))
    for (let i = 0; i < PREBUFFER_FRAGMENTS; i++)
      h.proc.stdout.emit('data', fragment(`old${i}`))

    h.delegate.handleRecordingStreamRequest(1)

    // Falls back to the 4000ms default against a 4000ms prebuffer = one.
    expect(h.log.info.mock.calls.flat().join(' ')).toContain(`1 of ${PREBUFFER_FRAGMENTS} prebuffered`)
    h.close(1)
  })

  // The pre-roll and the backlog bound used to be measured against the same
  // constant, so a long negotiated prebufferLength opened the queue at the
  // limit and the FIRST live fragment ended the clip with a "HomeKit is
  // behind" warning about a consumer that had not fallen behind at all.
  it('does not mistake a large negotiated pre-roll for a slow consumer', async () => {
    const h = await harnessStarted()
    h.delegate.updateRecordingConfiguration(configuration(4000))
    // 64s of pre-roll over 4s fragments = the whole ring.
    ;(h.delegate as unknown as { config: { prebufferLength: number } }).config.prebufferLength = 64_000
    h.proc.stdout.emit('data', init('one'))
    for (let i = 0; i < PREBUFFER_FRAGMENTS; i++)
      h.proc.stdout.emit('data', fragment(`old${i}`))

    const gen = h.delegate.handleRecordingStreamRequest(1)
    // A live fragment on top of a full pre-roll is NOT a backlog.
    h.proc.stdout.emit('data', fragment('live'))
    h.close(1)
    await drain(gen)

    expect(h.log.warn.mock.calls.flat().join(' ')).not.toContain('fragments behind')
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

  // Each run PRODUCES media and still dies immediately — a camera flapping, not
  // one that never connects. Producing is necessary for a healthy run but not
  // sufficient: without the lifetime half of the test as well, every one of
  // these would clear the tally and the slow cadence would be unreachable.
  it('slows the retry down after repeated short-lived runs instead of respawning every 10s', async () => {
    const h = await harnessStarted()
    for (let i = 0; i <= MAX_RESTARTS; i++) {
      h.proc.stdout.emit('data', init(`flap-${i}`))
      h.proc.emit('close', 1)
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
      await flush()
    }
    // The last exit scheduled a SLOW retry, so the fast interval buys nothing.
    expect(h.spawn).toHaveBeenCalledTimes(MAX_RESTARTS + 1)
    expect(h.log.warn.mock.calls.flat().join(' ')).toContain('failed 5 times in a row')
  })

  // Stopping outright was terminal: a camera reflashing takes longer than the
  // fast tally spans and fails fast throughout, so nothing ever retried again
  // until Homebridge was restarted.
  it('keeps retrying at the slow cadence, so a camera that comes back recovers on its own', async () => {
    const h = await harnessStarted()
    for (let i = 0; i <= MAX_RESTARTS; i++) {
      h.proc.emit('close', 1)
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
      await flush()
    }
    const spawns = h.spawn.mock.calls.length
    await vi.advanceTimersByTimeAsync(SLOW_RESTART_DELAY_MS)
    await flush()
    expect(h.spawn.mock.calls.length).toBe(spawns + 1)
    expect(h.delegate.encoding).toBe(true)
  })

  /**
   * Drives the delegate onto the slow cadence and leaves a fresh encoder
   * running, so the two tests below differ only in whether that encoder
   * produces anything. Date is faked here and nowhere else in this file: the
   * tally compares real timestamps.
   */
  async function onSlowCadence() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const h = await harnessStarted()
    for (let i = 0; i <= MAX_RESTARTS; i++) {
      h.proc.emit('close', 1)
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
      await flush()
    }
    // On the slow cadence now: the fast interval above bought nothing.
    const beforeSlow = h.spawn.mock.calls.length
    await vi.advanceTimersByTimeAsync(SLOW_RESTART_DELAY_MS)
    await flush()
    expect(h.spawn.mock.calls.length).toBe(beforeSlow + 1)
    return h
  }

  // The single load-bearing claim of "slow down, never stop": without this
  // reset a camera that comes back stays on the ten-minute cadence for the life
  // of the process, which is worse than the fast loop it replaced.
  it('returns to the fast retry after a run that lasted AND produced media', async () => {
    const h = await onSlowCadence()

    // The half that makes it a healthy run rather than merely a long one — and
    // it must be a FRAGMENT. This used to emit only `init`, which passed while
    // the source counted any piece as media, and therefore hid the defect below.
    h.proc.stdout.emit('data', init('recovered'))
    h.proc.stdout.emit('data', fragment('real-media'))
    await vi.advanceTimersByTimeAsync(HEALTHY_RUN_MS)
    const healthy = h.spawn.mock.calls.length
    h.proc.emit('close', 1)
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
    await flush()
    expect(h.spawn.mock.calls.length).toBe(healthy + 1)
    expect(h.delegate.encoding).toBe(true)
  })

  // The other direction, and the reason uptime alone was the wrong test: ffmpeg
  // connects, stalls, and sits there emitting nothing. It is alive for a full
  // healthy run every time, so an uptime-only reset cleared the tally on every
  // attempt and a genuinely broken camera respawned every 10 s forever —
  // exactly what the slow cadence exists to prevent.
  it('stays on the slow cadence after a long run that produced no media', async () => {
    const h = await onSlowCadence()

    // Alive for a full healthy run, and silent throughout. No stdout at all.
    await vi.advanceTimersByTimeAsync(HEALTHY_RUN_MS)
    const silent = h.spawn.mock.calls.length
    h.proc.emit('close', 1)
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
    await flush()
    // Nothing at the fast interval...
    expect(h.spawn.mock.calls.length).toBe(silent)
    // ...and the retry is still pending, not abandoned: it lands at the slow one.
    await vi.advanceTimersByTimeAsync(SLOW_RESTART_DELAY_MS - RESTART_DELAY_MS)
    await flush()
    expect(h.spawn.mock.calls.length).toBe(silent + 1)
    expect(h.delegate.encoding).toBe(true)
  })

  // The gap between the two tests above, and the one the "produced media" half
  // was actually failing to check: ffmpeg writes `ftyp+moov` the moment the
  // muxer opens, BEFORE encoding a single frame. An encoder that connects,
  // emits that header and then produces nothing recordable is not a healthy
  // run — but it used to count as one, so a camera in that state respawned
  // every 10 s forever instead of backing off. An init segment is the encoder
  // saying hello, not the encoder working.
  it('does not count an init segment alone as media', async () => {
    const h = await onSlowCadence()

    // A header and nothing else, for a full healthy run.
    h.proc.stdout.emit('data', init('header-only'))
    await vi.advanceTimersByTimeAsync(HEALTHY_RUN_MS)
    const before = h.spawn.mock.calls.length
    h.proc.emit('close', 1)
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
    await flush()

    // Still slow: nothing at the fast interval...
    expect(h.spawn.mock.calls.length).toBe(before)
    // ...and it does land at the slow one.
    await vi.advanceTimersByTimeAsync(SLOW_RESTART_DELAY_MS - RESTART_DELAY_MS)
    await flush()
    expect(h.spawn.mock.calls.length).toBe(before + 1)
  })

  it('warns about the slow cadence once, not on every further failure', async () => {
    const h = await harnessStarted()
    for (let i = 0; i < MAX_RESTARTS + 3; i++) {
      h.proc.emit('close', 1)
      await vi.advanceTimersByTimeAsync(SLOW_RESTART_DELAY_MS)
      await flush()
    }
    const warned = h.log.warn.mock.calls.flat().filter(m => (m as string).includes('times in a row'))
    expect(warned).toHaveLength(1)
  })

  // scheduleRestart used to be reachable only from onExit, so a retry whose
  // stream-url fetch failed produced no process and scheduled nothing: one
  // console blip ended recording for that camera permanently.
  it('retries a start that failed before any process existed', async () => {
    let fail = true
    const h = harness({ url: async () => {
      if (fail)
        throw new Error(`console unreachable for ${URL}`)
      return URL
    } })
    await h.start()
    expect(h.spawn).not.toHaveBeenCalled()
    fail = false
    await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS)
    await flush()
    expect(h.spawn).toHaveBeenCalledTimes(1)
    expect(h.delegate.encoding).toBe(true)
  })

  // HomeKit re-delivers `Active = true` on a CameraOperatingMode write, so a
  // start can run while an earlier retry is still pending. When that start also
  // fails, scheduleRestart used to assign straight over `restartTimer` — the
  // FIRST timer was then unreachable, and disposal cleared only the second. It
  // fired afterwards and fetched a stream URL for a camera that may already have
  // been removed. `get` is the observable: with the fix it stops at two calls.
  it('does not leave an orphaned restart timer behind when a retry lands on a pending one', async () => {
    const h = harness({ url: async () => {
      throw new Error(`console unreachable for ${URL}`)
    } })
    await h.start()
    expect(h.get).toHaveBeenCalledTimes(1)

    // The re-delivered write: startEncoder runs, fails, and schedules a SECOND
    // retry while the first is still pending.
    h.delegate.updateRecordingActive(true)
    await flush()
    expect(h.get).toHaveBeenCalledTimes(2)

    // Disposal. It can only clear the timer the field points at.
    h.delegate.updateRecordingActive(false)
    await vi.advanceTimersByTimeAsync(SLOW_RESTART_DELAY_MS)
    await flush()
    expect(h.get).toHaveBeenCalledTimes(2)
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
