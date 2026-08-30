/**
 * Pure mapping from a Protect event frame to the HomeKit sensor subtypes it
 * drives. No HomeKit types, no timers, no state — which is what makes the whole
 * event pipeline exhaustively testable from fixtures.
 *
 * Frames arrive unvalidated from the WebSocket. Nothing here may throw: a throw
 * propagates into the `ws` message callback and kills Homebridge.
 */

/** Detection types Protect can report. Anything else is ignored. */
const DETECT_TYPES = new Set(['person', 'vehicle', 'package', 'licensePlate', 'face', 'animal'])

/**
 * Only the two audio detections with a real HomeKit equivalent. Bark, car horn,
 * glass break and the rest have no sensible native service.
 */
const AUDIO_SUBTYPES = new Map([
  ['alrmSmoke', 'audio-alrmSmoke'],
  ['alrmCmonx', 'audio-alrmCmonx'],
])

/**
 * All three smart-detect channels can fire for one person walking past, so they
 * map to the same per-type subtypes. Sensors are keyed on detection type, never
 * on which channel reported it — otherwise one person triggers three times.
 */
const SMART_DETECT_EVENTS = new Set(['smartDetectZone', 'smartDetectLine', 'smartDetectLoiterZone'])

export type EventPhase = 'start' | 'end' | 'momentary'

export interface RoutedEvent {
  eventId: string
  deviceId: string
  /** Stable service subtypes this event drives, e.g. `detect-person`. */
  subtypes: string[]
  phase: EventPhase
  /** A ring has no end — it fires and is done. */
  stateless: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function detectSubtypes(item: Record<string, unknown>, lookup: (t: string) => string | undefined): string[] {
  const raw = item.smartDetectTypes
  if (!Array.isArray(raw))
    return []
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string')
      continue
    const subtype = lookup(entry)
    // An unknown type from a firmware update is dropped, never thrown.
    if (subtype && !out.includes(subtype))
      out.push(subtype)
  }
  return out
}

export function routeEvent(frame: unknown): RoutedEvent | null {
  const outer = asRecord(frame)
  const item = outer && asRecord(outer.item)
  if (!item)
    return null

  const eventId = item.id
  const deviceId = item.device
  const type = item.type
  if (typeof eventId !== 'string' || typeof deviceId !== 'string' || typeof type !== 'string')
    return null

  let subtypes: string[]
  let stateless = false

  if (type === 'motion') {
    subtypes = ['motion']
  }
  else if (SMART_DETECT_EVENTS.has(type)) {
    // Protect 7.2.105 emits classic `motion` events only for doorbells; every
    // other camera surfaces motion purely as smart-detect events. Without the
    // leading `motion` subtype here, a camera's Motion sensor — the tile
    // HomeKit notifications, automations and HKSV key off — never fires on
    // those cameras, and only the doorbell ever appears to detect motion. A
    // smart detection IS motion, so the generic sensor rides along with the
    // per-type ones; the tracker's holder counts keep it on until every
    // overlapping event has ended.
    subtypes = ['motion', ...detectSubtypes(item, t => (DETECT_TYPES.has(t) ? `detect-${t}` : undefined))]
  }
  else if (type === 'smartAudioDetect') {
    subtypes = detectSubtypes(item, t => AUDIO_SUBTYPES.get(t))
  }
  else if (type === 'ring') {
    subtypes = ['ring']
    stateless = true
  }
  else {
    return null
  }

  if (subtypes.length === 0)
    return null

  // `end` is an absent key on in-progress events on real hardware — never an
  // explicit null. Both absence and (a defensive) null fall through to `false`
  // here, so neither shape can be mistaken for a completed event.
  const ended = typeof item.end === 'number'
  const phase: EventPhase = ended
    ? (outer.type === 'add' ? 'momentary' : 'end')
    : 'start'

  return { eventId, deviceId, subtypes, phase, stateless }
}
