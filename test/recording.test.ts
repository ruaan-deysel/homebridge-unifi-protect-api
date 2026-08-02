import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { PREBUFFER_FRAGMENTS, PrebufferRing } from '../src/accessories/recording.js'

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
