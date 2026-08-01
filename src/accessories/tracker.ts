import type { RoutedEvent } from './router.js'

/**
 * A sensor stuck on forever is the worst outcome here, so every active event
 * carries a deadline. Two minutes is generous — real motion events routinely run
 * for a minute — but bounded.
 */
const FAILSAFE_MS = 120_000

/**
 * What the tracker hands to a subscriber on every transition.
 *
 * `deviceId` is required: the failsafe callback hands the platform a batch of
 * changes with no surrounding frame to read a device from, so it is the only
 * thing that can route a change to the right accessory. The tracker has always
 * populated it — making it optional would only buy a branch in the platform
 * that can never be taken.
 */
export interface SensorChange {
  deviceId: string
  subtype: string
  active: boolean
}

export interface EventTrackerOptions {
  failsafeMs?: number
}

/**
 * Reference-counts sensor subtypes across overlapping events.
 *
 * State lives here rather than on the HomeKit services because two events can
 * hold the same sensor on — a person triggering both `smartDetectZone` and
 * `smartDetectLine` — and it must only clear when both have ended.
 *
 * Hardware fact this class exists to survive: the Protect console redelivers
 * the end frame for the same event id — observed up to 3 times, always with an
 * identical `end` value. Ends are keyed on eventId and the entry is deleted on
 * the first one processed, so the second and third are no-ops. Decrementing a
 * holder count on every redelivered end would drive it negative and switch a
 * still-genuinely-active sensor off.
 */
export class EventTracker {
  /** eventId -> the subtypes it holds, so an end frame can find and release them. */
  private readonly active = new Map<string, { deviceId: string, subtypes: string[], timer: ReturnType<typeof setTimeout> }>()
  /** `${deviceId}:${subtype}` -> number of events currently holding it active. */
  private readonly holders = new Map<string, number>()
  private readonly failsafeMs: number
  private stopped = false

  /** Set by the platform to apply changes produced by a failsafe expiry. */
  onFailsafe: (changes: SensorChange[]) => void = () => {}

  constructor(options: EventTrackerOptions = {}) {
    this.failsafeMs = options.failsafeMs ?? FAILSAFE_MS
  }

  get activeCount(): number {
    return this.active.size
  }

  apply(routed: RoutedEvent): SensorChange[] {
    if (this.stopped)
      return []

    // A ring has no duration in HomeKit — fire once on the frame that announces
    // it, store nothing. Real hardware sends a later `update` carrying `end` for
    // the same event id (a ring can stay open 300+ seconds); that end frame must
    // be a no-op here, not a second trigger.
    if (routed.stateless) {
      return routed.phase === 'start'
        ? routed.subtypes.map(subtype => ({ deviceId: routed.deviceId, subtype, active: true }))
        : []
    }

    if (routed.phase === 'momentary') {
      // Too short to span two frames. Report the transition in both directions so
      // a brief detection is visible rather than silently dropped.
      return [
        ...routed.subtypes.map(subtype => ({ deviceId: routed.deviceId, subtype, active: true })),
        ...routed.subtypes.map(subtype => ({ deviceId: routed.deviceId, subtype, active: false })),
      ]
    }

    return routed.phase === 'start' ? this.start(routed) : this.end(routed.eventId)
  }

  private start(routed: RoutedEvent): SensorChange[] {
    // A duplicate start for an event id already tracked (or a start that arrives
    // after a stray duplicate end already released it while genuinely still
    // running would be indistinguishable from a new event) is a no-op.
    if (this.active.has(routed.eventId))
      return []

    const timer = setTimeout(() => {
      const changes = this.end(routed.eventId)
      if (changes.length)
        this.onFailsafe(changes)
    }, this.failsafeMs)
    timer.unref?.()

    this.active.set(routed.eventId, { deviceId: routed.deviceId, subtypes: routed.subtypes, timer })

    const changes: SensorChange[] = []
    for (const subtype of routed.subtypes) {
      const key = `${routed.deviceId}:${subtype}`
      const next = (this.holders.get(key) ?? 0) + 1
      this.holders.set(key, next)
      if (next === 1)
        changes.push({ deviceId: routed.deviceId, subtype, active: true })
    }
    return changes
  }

  /**
   * Idempotent by construction: the entry is deleted on the first end this
   * event id sees, so a redelivered end (observed up to 3x on real hardware,
   * always with an identical `end` value) finds nothing here and returns `[]`
   * without touching the holder counts.
   */
  private end(eventId: string): SensorChange[] {
    const entry = this.active.get(eventId)
    if (!entry)
      return []
    clearTimeout(entry.timer)
    this.active.delete(eventId)

    const changes: SensorChange[] = []
    for (const subtype of entry.subtypes) {
      const key = `${entry.deviceId}:${subtype}`
      const next = (this.holders.get(key) ?? 1) - 1
      if (next <= 0) {
        this.holders.delete(key)
        changes.push({ deviceId: entry.deviceId, subtype, active: false })
      }
      else {
        this.holders.set(key, next)
      }
    }
    return changes
  }

  /**
   * Called on `resyncRequired`. Frames missed while a socket was down are never
   * replayed and there is no REST endpoint for events, so an event that was open
   * across a reconnect can never be resolved — assume it ended. Clearing early is
   * better than a sensor stuck on indefinitely.
   */
  clearAll(): SensorChange[] {
    const changes: SensorChange[] = []
    for (const eventId of [...this.active.keys()])
      changes.push(...this.end(eventId))
    return changes
  }

  stop(): void {
    this.stopped = true
    for (const entry of this.active.values())
      clearTimeout(entry.timer)
    this.active.clear()
    this.holders.clear()
  }
}
