import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { Fmp4Splitter } from '../src/protect/fmp4.js'

function box(type: string, payload = Buffer.alloc(4)) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + payload.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, payload])
}

describe('fmp4Splitter', () => {
  it('emits the initialization segment once ftyp and moov have arrived', () => {
    const out: Array<{ kind: string, data: Buffer }> = []
    const split = new Fmp4Splitter((kind, data) => out.push({ kind, data }))
    split.push(Buffer.concat([box('ftyp'), box('moov')]))
    expect(out.map(o => o.kind)).toEqual(['init'])
  })

  it('emits each moof+mdat pair as one fragment', () => {
    const out: Array<{ kind: string, data: Buffer }> = []
    const split = new Fmp4Splitter((kind, data) => out.push({ kind, data }))
    split.push(Buffer.concat([box('ftyp'), box('moov'), box('moof'), box('mdat'), box('moof'), box('mdat')]))
    expect(out.map(o => o.kind)).toEqual(['init', 'fragment', 'fragment'])
  })

  it('waits for a box split across two chunks', () => {
    const out: string[] = []
    const split = new Fmp4Splitter(kind => out.push(kind))
    const whole = Buffer.concat([box('ftyp'), box('moov')])
    split.push(whole.subarray(0, 5))
    expect(out).toEqual([])
    split.push(whole.subarray(5))
    expect(out).toEqual(['init'])
  })

  it('waits for a box split after the header, mid-payload', () => {
    const out: string[] = []
    const split = new Fmp4Splitter(kind => out.push(kind))
    const whole = Buffer.concat([box('ftyp'), box('moov', Buffer.from('abcdefgh'))])
    // Split 10 bytes in: past the 8-byte header of the second box, but before
    // its payload is complete.
    split.push(whole.subarray(0, 10))
    expect(out).toEqual([])
    split.push(whole.subarray(10))
    expect(out).toEqual(['init'])
  })

  it('ignores an mdat with no preceding moof rather than emitting a bare fragment', () => {
    const out: string[] = []
    const split = new Fmp4Splitter(kind => out.push(kind))
    split.push(Buffer.concat([box('ftyp'), box('moov'), box('mdat')]))
    expect(out).toEqual(['init'])
  })

  it('rejects a nonsense box length instead of looping', () => {
    const bad = Buffer.alloc(8)
    bad.writeUInt32BE(3, 0)
    bad.write('moof', 4, 'latin1')
    const split = new Fmp4Splitter(() => {})
    expect(() => split.push(bad)).toThrow(/box length/i)
  }, 1000)

  // The lower bound stops the loop spinning; without an upper bound a corrupt
  // length simply keeps `pending.length < length` true while every chunk is
  // concatenated on — 4 GB of accumulation before anything throws.
  it('rejects an oversized box length instead of buffering towards it', () => {
    const bad = Buffer.alloc(16)
    bad.writeUInt32BE(0xFFFFFFFF, 0)
    bad.write('mdat', 4, 'latin1')
    const split = new Fmp4Splitter(() => {})
    expect(() => split.push(bad)).toThrow(/box length/i)
  }, 1000)

  it('accepts a fragment far larger than any real one, so the bound cannot reject legitimate media', () => {
    const out: string[] = []
    const split = new Fmp4Splitter(kind => out.push(kind))
    // 8 MB — about 32x a measured 4 s fragment on the high substream.
    split.push(Buffer.concat([box('moof'), box('mdat', Buffer.alloc(8 * 1024 * 1024))]))
    expect(out).toEqual(['fragment'])
  })

  /**
   * The throw consumes nothing, so without a latch every later chunk is
   * concatenated onto the same corrupt prefix and throws again — `pending`
   * growing without limit while the caller warns once per chunk. Asserted on
   * the second push, which is the one that used to re-throw.
   */
  it('drops every chunk after a corrupt box length instead of re-throwing on each one', () => {
    const bad = Buffer.alloc(8)
    bad.writeUInt32BE(0xFFFFFFFF, 0)
    bad.write('mdat', 4, 'latin1')
    const out: string[] = []
    const split = new Fmp4Splitter(kind => out.push(kind))

    expect(() => split.push(bad)).toThrow(/box length/i)
    expect(split.wedged).toBe(true)

    // Perfectly well-formed media, and still dropped: the framing is lost.
    expect(() => split.push(Buffer.concat([box('ftyp'), box('moov')]))).not.toThrow()
    expect(() => split.push(Buffer.concat([box('moof'), box('mdat')]))).not.toThrow()
    expect(out).toEqual([])
  })

  it('holds nothing after a corrupt box length, so a wedged splitter cannot grow', () => {
    const bad = Buffer.alloc(8)
    bad.writeUInt32BE(0xFFFFFFFF, 0)
    bad.write('mdat', 4, 'latin1')
    const split = new Fmp4Splitter(() => {})

    expect(() => split.push(bad)).toThrow(/box length/i)

    // The buffer the guard refused to accumulate towards is released.
    expect((split as unknown as { pending: Buffer }).pending).toHaveLength(0)
    split.push(Buffer.alloc(1024))
    expect((split as unknown as { pending: Buffer }).pending).toHaveLength(0)
  })

  it('emits the fragment payload as the concatenation of the moof and mdat boxes, not just their headers', () => {
    const moof = box('moof', Buffer.from('MOOF-PAYLOAD'))
    const mdat = box('mdat', Buffer.from('MDAT-PAYLOAD'))
    const chunks: Buffer[] = []
    const split = new Fmp4Splitter((kind, data) => {
      if (kind === 'fragment')
        chunks.push(data)
    })
    split.push(Buffer.concat([box('ftyp'), box('moov'), moof, mdat]))
    expect(chunks).toEqual([Buffer.concat([moof, mdat])])
  })
})
