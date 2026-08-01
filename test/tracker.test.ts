import type { RoutedEvent } from '../src/accessories/router.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { routeEvent } from '../src/accessories/router.js'
import { EventTracker } from '../src/accessories/tracker.js'

function ev(eventId: string, subtypes: string[], phase: RoutedEvent['phase'] = 'start'): RoutedEvent {
  return { eventId, deviceId: 'cam1', subtypes, phase, stateless: false }
}

function loadFixture(name: string): unknown[] {
  const path = fileURLToPath(new URL(`./fixtures/events/${name}`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as unknown[]
}

describe('eventTracker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('activates a subtype on first holder only', () => {
    const t = new EventTracker()
    expect(t.apply(ev('e1', ['detect-person']))).toEqual([{ deviceId: 'cam1', subtype: 'detect-person', active: true }])
    // Second overlapping event: already active, so no transition is reported.
    expect(t.apply(ev('e2', ['detect-person']))).toEqual([])
  })

  it('keeps a subtype active until every holder ends', () => {
    const t = new EventTracker()
    t.apply(ev('e1', ['detect-person']))
    t.apply(ev('e2', ['detect-person']))
    expect(t.apply(ev('e1', ['detect-person'], 'end'))).toEqual([])
    expect(t.apply(ev('e2', ['detect-person'], 'end')))
      .toEqual([{ deviceId: 'cam1', subtype: 'detect-person', active: false }])
  })

  it('does not double-count a duplicate start for one event id', () => {
    const t = new EventTracker()
    t.apply(ev('e1', ['motion']))
    expect(t.apply(ev('e1', ['motion']))).toEqual([])
    expect(t.apply(ev('e1', ['motion'], 'end')))
      .toEqual([{ deviceId: 'cam1', subtype: 'motion', active: false }])
  })

  it('returns an on-then-off pair for a momentary event', () => {
    const t = new EventTracker()
    expect(t.apply(ev('e1', ['motion'], 'momentary'))).toEqual([
      { deviceId: 'cam1', subtype: 'motion', active: true },
      { deviceId: 'cam1', subtype: 'motion', active: false },
    ])
  })

  it('treats a stateless event as a single trigger and stores nothing', () => {
    const t = new EventTracker()
    const routed: RoutedEvent = { eventId: 'r1', deviceId: 'cam1', subtypes: ['ring'], phase: 'start', stateless: true }
    expect(t.apply(routed)).toEqual([{ deviceId: 'cam1', subtype: 'ring', active: true }])
    expect(t.activeCount).toBe(0)
  })

  it('ignores the later end frame for a stateless ring instead of firing again', () => {
    // Real hardware: a ring stays open up to 302s before its end frame arrives.
    // Treating that end as a second trigger would surface a doorbell press as
    // "active" again minutes later.
    const t = new EventTracker()
    const start: RoutedEvent = { eventId: 'r1', deviceId: 'cam1', subtypes: ['ring'], phase: 'start', stateless: true }
    const end: RoutedEvent = { eventId: 'r1', deviceId: 'cam1', subtypes: ['ring'], phase: 'end', stateless: true }
    expect(t.apply(start)).toEqual([{ deviceId: 'cam1', subtype: 'ring', active: true }])
    expect(t.apply(end)).toEqual([])
  })

  it('clears an event whose end frame never arrives', () => {
    const t = new EventTracker({ failsafeMs: 1000 })
    const changes: unknown[] = []
    t.onFailsafe = c => changes.push(...c)
    t.apply(ev('e1', ['motion']))
    vi.advanceTimersByTime(1001)
    expect(changes).toEqual([{ deviceId: 'cam1', subtype: 'motion', active: false }])
    expect(t.activeCount).toBe(0)
  })

  it('clearAll deactivates everything after a resync', () => {
    const t = new EventTracker()
    t.apply(ev('e1', ['motion']))
    t.apply(ev('e2', ['detect-person']))
    expect(t.clearAll()).toEqual([
      { deviceId: 'cam1', subtype: 'motion', active: false },
      { deviceId: 'cam1', subtype: 'detect-person', active: false },
    ])
    expect(t.activeCount).toBe(0)
  })

  it('stop cancels timers so nothing fires afterwards', () => {
    const t = new EventTracker({ failsafeMs: 1000 })
    const changes: unknown[] = []
    t.onFailsafe = c => changes.push(...c)
    t.apply(ev('e1', ['motion']))
    // Assert the timer actually exists before stop() — otherwise this test
    // could pass by never having created one in the first place.
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    t.stop()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(changes).toEqual([])
  })

  describe('driven from real captured hardware frames (test/fixtures/events/end-frames.json)', () => {
    // This fixture deliberately preserves duplicate end frames captured from a
    // real console: event id ...002 and ...006 each redeliver their end 3 times,
    // and ...001 and ...005 redeliver theirs twice, always with an identical
    // `end` value. A tracker that decrements its holder count on every
    // redelivery instead of keying on event id would go negative and could
    // flip a still-active sensor off — this is the exact bug reference
    // counting exists to prevent, and it happens on day one on this hardware.
    it('applies every duplicate end as a no-op and ends each subtype exactly once', () => {
      const t = new EventTracker()
      const frames = loadFixture('end-frames.json')
      const routedFrames = frames
        .map(frame => routeEvent((frame as { payload: unknown }).payload))
      for (const routed of routedFrames)
        expect(routed).not.toBeNull()

      // The fixture isolates the end-phase frames a real capture produced; the
      // matching start for each event id arrived earlier, outside this window,
      // and (per the capture) each event had ended before the next one holding
      // the same subtype began. Synthesize each start immediately before the
      // first frame naming its event id, preserving that non-overlap, so a
      // shared device+subtype (e.g. repeated `motion` on one camera) is not
      // artificially treated as concurrently held by several events at once.
      const seen = new Set<string>()
      const offTransitions: { deviceId?: string, subtype: string }[] = []
      for (const routed of routedFrames) {
        if (!routed)
          continue
        if (!routed.stateless && !seen.has(routed.eventId)) {
          seen.add(routed.eventId)
          t.apply({ ...routed, phase: 'start' })
        }
        // Drive the tracker exactly as the platform would, one frame at a time,
        // in fixture order — duplicates included.
        const changes = t.apply(routed)
        for (const change of changes) {
          if (!change.active)
            offTransitions.push({ deviceId: change.deviceId, subtype: change.subtype })
        }
      }

      // Every distinct, stateful event id in the fixture ends exactly once,
      // regardless of how many duplicate end frames it produced (...002 and
      // ...006 redeliver 3x, ...001 and ...005 redeliver 2x).
      expect(offTransitions.length).toBe(seen.size)
      expect(t.activeCount).toBe(0)
    })
  })
})
