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

  it('rejects a nonsense box length instead of looping', () => {
    const bad = Buffer.alloc(8)
    bad.writeUInt32BE(3, 0)
    bad.write('moof', 4, 'latin1')
    const split = new Fmp4Splitter(() => {})
    expect(() => split.push(bad)).toThrow(/box length/i)
  }, 1000)

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
