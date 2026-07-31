# Camera Sensors and Controls Implementation Plan (sub-project 2a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every camera accessory motion, per-type smart-detect, doorbell, smoke/CO sensors and a status-LED switch, driven entirely by the Protect event stream.

**Architecture:** A pure router turns a Protect event frame into a list of affected sensor subtypes and a phase (`start` / `end` / `momentary`). A tracker holds active events and reference-counts subtypes, so two overlapping events cannot clear one sensor early, and it owns the failsafe timers. An accessory builder creates and diffs services on the camera accessory. `src/platform.ts` wires `protectEvent` — which the foundation emits but nothing currently consumes — through router → tracker → builder.

**Tech Stack:** TypeScript, Homebridge v2 (`hap-nodejs` services), Zod 4, vitest. No new dependencies.

**Global Constraints:**
- Runtime dependencies stay EXACTLY `zod`, `@homebridge/plugin-ui-utils`, `ws`. Adding any is a plan violation.
- `src/protect/**` must not import from `homebridge` or `hap-nodejs`. The router and tracker live in `src/accessories/` precisely so they stay HomeKit-free and unit-testable; only the builder and `platform.ts` touch HAP.
- Event frames arrive **unvalidated** as `unknown`. Nothing in an event handler may throw — a throw propagates into the `ws` message callback and kills Homebridge.
- Zod validation logs and degrades, never throws.
- No `fetch` in `src/`. Transport is `node:https`.
- Service subtypes are stable strings derived from the detection type, NEVER from an array index.
- **Service removal is destructive and follows the accessory-removal rules**: it happens only on a discovery confirmed successful, never on a degraded or partial one.
- The API key must never reach a log line or `util.inspect`.

**User decisions (already made):**
- "Sensors first, then streaming" — 2a is sensors and controls only; streaming, snapshots and talkback are 2b.
- "One sensor per enabled type, per camera" — only detection types currently enabled in Protect get a sensor.
- "Map smoke and CO only, if enabled" — `alrmSmoke` → SmokeSensor, `alrmCmonx` → CarbonMonoxideSensor; other audio types are not exposed.
- "Status LED only" — the LED switch is the sole write path into Protect.
- PTZ dropped entirely: all five cameras report `activePatrolSlot: null` and none are PTZ models.
- "I cannot test now but can do it tomorrow" — Task 0 (fixture capture) requires the user and gates everything after it.

**Reference spec:** `docs/superpowers/specs/2026-07-31-camera-sensors-design.md`

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/accessories/router.ts` | **Pure.** Protect event frame → `RoutedEvent` (subtypes + phase). No HomeKit, no timers, no state. |
| `src/accessories/tracker.ts` | Active-event map, subtype reference counting, failsafe timers, resync clear. No HomeKit. |
| `src/accessories/camera.ts` | Builds and diffs HAP services on a camera accessory; applies sensor updates; owns the LED switch. |
| `src/platform.ts` (modify) | Wires `protectEvent` → router → tracker → builder; calls the builder from `reconcile`. |
| `test/fixtures/events/*.json` | **Real** captured event frames. Task 0. |
| `test/router.test.ts`, `test/tracker.test.ts`, `test/camera.test.ts` | Unit suites. |
| `scripts/capture-events.mjs` | Fixture capture tool. Task 0. |

The router/tracker split exists because the tracker needs timers and mutable state while the router does not. Keeping the router pure is what makes exhaustive fixture-driven testing possible.

---

### Task 0: Capture real event fixtures from hardware

**Goal:** Produce real `motion`, `smartDetectZone`, `ring` and end-frame payloads from the user's console, so every downstream test is built on observed data rather than the spec.

> **USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**Files:**
- Create: `scripts/capture-events.mjs`
- Create: `test/fixtures/events/{motion,smart-detect,ring,end-frames}.json`

**Acceptance Criteria:**
- [ ] `scripts/capture-events.mjs` connects to both subscriptions and writes every frame to disk with a timestamp
- [ ] Captured fixtures contain at least one real `motion` event, one `smartDetectZone` event carrying a non-empty `smartDetectTypes`, and one `ring` event
- [ ] Captured fixtures contain at least one `update` frame with a non-null `end` for a previously-seen `eventId`
- [ ] Fixtures are redacted consistently — the same real device id maps to the same fake id in every file, so `event.device` still matches `cameras[].id` in the existing fixtures
- [ ] No API key, real MAC, or stream token appears in any fixture

**Verify:** `node scripts/capture-events.mjs --seconds 120` produces frames; `grep -rE "REDACTED-KEY-PREFIX|F4E2C6" test/fixtures/events/` → no matches

**Steps:**

- [ ] **Step 1: Write `scripts/capture-events.mjs`**

```js
#!/usr/bin/env node
// Captures live Protect event frames to build test fixtures from observed data
// rather than from the OpenAPI spec. The spec has already been wrong twice on
// this hardware (ringSettings.ringtoneId, nvrArmMode.armProfileId are marked
// required but never sent), so event shapes are not trusted until seen.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import process from 'node:process'
import WebSocket from 'ws'

const env = Object.fromEntries(
  readFileSync('.env', 'utf8').split('\n')
    .map(l => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean)
    .map(m => [m[1], m[2].trim()]),
)
const host = env.PROTECT_HOST
const apiKey = env.PROTECT_API_KEY
if (!host || !apiKey) {
  console.error('Set PROTECT_HOST and PROTECT_API_KEY in .env')
  process.exit(2)
}

const seconds = Number(process.argv[process.argv.indexOf('--seconds') + 1]) || 120
const frames = []

for (const channel of ['devices', 'events']) {
  const ws = new WebSocket(`wss://${host}/proxy/protect/integration/v1/subscribe/${channel}`, {
    headers: { 'X-API-KEY': apiKey },
    rejectUnauthorized: false,
  })
  ws.on('open', () => console.error(`[${channel}] listening`))
  ws.on('error', e => console.error(`[${channel}] error: ${e.message}`))
  ws.on('message', (raw) => {
    let payload
    try { payload = JSON.parse(raw.toString()) }
    catch { return }
    frames.push({ channel, at: Date.now(), payload })
    const item = payload.item ?? {}
    console.error(`[${channel}] ${payload.type} ${item.type ?? item.modelKey ?? ''} ${item.smartDetectTypes ? JSON.stringify(item.smartDetectTypes) : ''}`)
  })
}

console.error(`\nWalk past a camera, then press the doorbell. Capturing for ${seconds}s...\n`)
setTimeout(() => {
  mkdirSync('test/fixtures/events', { recursive: true })
  writeFileSync('test/fixtures/events/raw-capture.json', JSON.stringify(frames, null, 2))
  console.error(`\nWrote ${frames.length} frames to test/fixtures/events/raw-capture.json`)
  process.exit(0)
}, seconds * 1000)
```

- [ ] **Step 2: Ask the user to trigger events, then run the capture**

Tell the user plainly what is needed: walk past one camera (ideally Driveway, which has person, vehicle and animal enabled), then press the doorbell. Then run:

Run: `node scripts/capture-events.mjs --seconds 120`
Expected: lines like `[events] add smartDetectZone ["person"]` and `[events] add ring`, followed by `update` lines.

If no `smartDetectZone` appears, ask the user to walk closer to the camera — generic `motion` fires more readily than smart detection.

- [ ] **Step 3: Split and redact the raw capture**

Write a one-off node script (do not commit it) that reads `raw-capture.json`, groups frames by `payload.item.type`, and writes `motion.json`, `smart-detect.json`, `ring.json` and `end-frames.json`. Build a redaction map from every 24-hex-character id seen, and reuse the **existing** fake ids from `test/fixtures/cameras.json` where the real id matches — otherwise `event.device` will no longer match any camera and the router tests become meaningless.

- [ ] **Step 4: Verify no secrets**

Run: `grep -rE "REDACTED-KEY-PREFIX|F4E2C6" test/fixtures/events/ ; echo "exit: $?"`
Expected: exit 1, no matches.

- [ ] **Step 5: Record what was actually observed**

Append to the report: the exact field names and value shapes seen, and — importantly — **any discrepancy from the OpenAPI spec**. The spec says every event carries `id`, `modelKey`, `type`, `start`, `end`, `device`. If reality differs, that is a finding and the router must follow reality.

- [ ] **Step 6: Commit**

```bash
git add scripts/capture-events.mjs test/fixtures/events
git commit -m "test: capture real protect event fixtures from hardware"
```

---

### Task 1: Pure event router

**Goal:** A synchronous, HomeKit-free function turning an event frame into the sensor subtypes it drives and its phase.

**Files:**
- Create: `src/accessories/router.ts`
- Test: `test/router.test.ts`

**Acceptance Criteria:**
- [ ] `routeEvent(frame)` returns `null` for anything it does not handle, and never throws — including for `null`, primitives, missing `item`, and a non-string `type`
- [ ] `motion` events map to subtype `motion`
- [ ] `smartDetectZone`, `smartDetectLine` and `smartDetectLoiterZone` all map to `detect-<type>` for each entry in `smartDetectTypes`
- [ ] `smartAudioDetect` maps `alrmSmoke` → `audio-alrmSmoke` and `alrmCmonx` → `audio-alrmCmonx`, and ignores every other audio type
- [ ] `ring` maps to subtype `ring` with `stateless: true`
- [ ] Phase is `start` when `end` is null, `end` when `end` is a number on an `update`, and `momentary` when an `add` already carries a non-null `end`
- [ ] An unknown `smartDetectTypes` entry is ignored, not thrown

**Verify:** `npx vitest run test/router.test.ts` → all passing

**Steps:**

- [ ] **Step 1: Write `test/router.test.ts` first, driven by the Task 0 fixtures**

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { routeEvent } from '../src/accessories/router.js'

const load = (n: string) => JSON.parse(readFileSync(`test/fixtures/events/${n}.json`, 'utf8'))

describe('routeEvent', () => {
  it('never throws on malformed input', () => {
    for (const bad of [null, undefined, 0, 'x', [], {}, { item: null }, { item: { type: 5 } }, { type: 'add' }])
      expect(() => routeEvent(bad)).not.toThrow()
  })

  it('returns null for frames it does not handle', () => {
    expect(routeEvent({ type: 'add', item: { type: 'somethingNew', device: 'd', id: 'e' } })).toBeNull()
  })

  it('maps a real motion event to the motion subtype', () => {
    const frame = load('motion').find((f: { payload: { type: string } }) => f.payload.type === 'add')
    const routed = routeEvent(frame.payload)
    expect(routed).toMatchObject({ subtypes: ['motion'], phase: 'start', stateless: false })
    expect(routed!.deviceId).toBe(frame.payload.item.device)
  })

  it('maps every smart-detect channel to per-type subtypes', () => {
    for (const type of ['smartDetectZone', 'smartDetectLine', 'smartDetectLoiterZone']) {
      const routed = routeEvent({
        type: 'add',
        item: { id: 'e1', device: 'cam1', type, start: 1, end: null, smartDetectTypes: ['person', 'vehicle'] },
      })
      expect(routed?.subtypes, type).toEqual(['detect-person', 'detect-vehicle'])
    }
  })

  it('maps only smoke and CO from audio detection', () => {
    const routed = routeEvent({
      type: 'add',
      item: { id: 'e2', device: 'cam1', type: 'smartAudioDetect', start: 1, end: null,
        smartDetectTypes: ['alrmSmoke', 'alrmBark', 'alrmCmonx', 'alrmCarHorn'] },
    })
    expect(routed?.subtypes).toEqual(['audio-alrmSmoke', 'audio-alrmCmonx'])
  })

  it('drops an unknown detection type without throwing', () => {
    const routed = routeEvent({
      type: 'add',
      item: { id: 'e3', device: 'cam1', type: 'smartDetectZone', start: 1, end: null,
        smartDetectTypes: ['person', 'teleporter'] },
    })
    expect(routed?.subtypes).toEqual(['detect-person'])
  })

  it('returns null when every detection type is unknown', () => {
    expect(routeEvent({
      type: 'add',
      item: { id: 'e4', device: 'cam1', type: 'smartDetectZone', start: 1, end: null, smartDetectTypes: ['teleporter'] },
    })).toBeNull()
  })

  it('marks a ring as stateless', () => {
    const routed = routeEvent({ type: 'add', item: { id: 'e5', device: 'cam1', type: 'ring', start: 1, end: null } })
    expect(routed).toMatchObject({ subtypes: ['ring'], stateless: true })
  })

  it('distinguishes the three phases', () => {
    const base = { id: 'e6', device: 'cam1', type: 'motion', start: 1 }
    expect(routeEvent({ type: 'add', item: { ...base, end: null } })?.phase).toBe('start')
    expect(routeEvent({ type: 'update', item: { ...base, end: 2 } })?.phase).toBe('end')
    // An `add` that already carries an end is a detection too short to span two frames.
    expect(routeEvent({ type: 'add', item: { ...base, end: 2 } })?.phase).toBe('momentary')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/router.test.ts`
Expected: FAIL — cannot resolve `../src/accessories/router.js`.

- [ ] **Step 3: Write `src/accessories/router.ts`**

```ts
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
    subtypes = detectSubtypes(item, t => (DETECT_TYPES.has(t) ? `detect-${t}` : undefined))
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

  const ended = typeof item.end === 'number'
  const phase: EventPhase = ended
    ? (outer.type === 'add' ? 'momentary' : 'end')
    : 'start'

  return { eventId, deviceId, subtypes, phase, stateless }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/router.test.ts`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/accessories/router.ts test/router.test.ts
git commit -m "feat(accessories): pure protect event router"
```

---

### Task 2: Active-event tracker

**Goal:** Reference-counted sensor state with failsafe timers, so overlapping events cannot clear a sensor early and a lost end-frame cannot strand one on forever.

**Files:**
- Create: `src/accessories/tracker.ts`
- Test: `test/tracker.test.ts`

**Acceptance Criteria:**
- [ ] Two overlapping events driving the same subtype keep it active until BOTH end
- [ ] A `start` returns `{subtype, active: true}` only on the transition from 0 to 1 holders
- [ ] An `end` returns `{subtype, active: false}` only on the transition to 0 holders
- [ ] A `momentary` phase returns an on-then-off pair for the subtype
- [ ] A stateless event (ring) returns a single `active: true` and registers no state
- [ ] A failsafe timer clears an event that never receives its end frame
- [ ] `clearAll()` deactivates everything and returns the resulting transitions
- [ ] `stop()` cancels every timer so nothing fires after shutdown
- [ ] A duplicate `start` for the same `eventId` does not double-count

**Verify:** `npx vitest run test/tracker.test.ts` → all passing

**Steps:**

- [ ] **Step 1: Write `test/tracker.test.ts` first**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventTracker } from '../src/accessories/tracker.js'
import type { RoutedEvent } from '../src/accessories/router.js'

const ev = (eventId: string, subtypes: string[], phase: RoutedEvent['phase'] = 'start'): RoutedEvent =>
  ({ eventId, deviceId: 'cam1', subtypes, phase, stateless: false })

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
    t.stop()
    vi.advanceTimersByTime(5000)
    expect(changes).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/tracker.test.ts`
Expected: FAIL — cannot resolve `../src/accessories/tracker.js`.

- [ ] **Step 3: Write `src/accessories/tracker.ts`**

```ts
import type { RoutedEvent } from './router.js'

/**
 * A sensor stuck on forever is the worst outcome here, so every active event
 * carries a deadline. Two minutes is generous — real motion events routinely run
 * for a minute — but bounded.
 */
const FAILSAFE_MS = 120_000

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
 */
export class EventTracker {
  /** eventId -> the subtypes it holds. */
  private readonly active = new Map<string, { deviceId: string, subtypes: string[], timer: ReturnType<typeof setTimeout> }>()
  /** `${deviceId} ${subtype}` -> number of events currently holding it. */
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

    // A ring has no end frame and no duration — fire once, store nothing.
    if (routed.stateless)
      return routed.subtypes.map(subtype => ({ deviceId: routed.deviceId, subtype, active: true }))

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
      const key = `${routed.deviceId} ${subtype}`
      const next = (this.holders.get(key) ?? 0) + 1
      this.holders.set(key, next)
      if (next === 1)
        changes.push({ deviceId: routed.deviceId, subtype, active: true })
    }
    return changes
  }

  private end(eventId: string): SensorChange[] {
    const entry = this.active.get(eventId)
    if (!entry)
      return []
    clearTimeout(entry.timer)
    this.active.delete(eventId)

    const changes: SensorChange[] = []
    for (const subtype of entry.subtypes) {
      const key = `${entry.deviceId} ${subtype}`
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/tracker.test.ts`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/accessories/tracker.ts test/tracker.test.ts
git commit -m "feat(accessories): reference-counted event tracker with failsafe"
```

---

### Task 3: Camera accessory service builder

**Goal:** Create, diff and remove HAP services on a camera accessory, and apply sensor changes to them.

**Files:**
- Create: `src/accessories/camera.ts`
- Test: `test/camera.test.ts`

**Acceptance Criteria:**
- [ ] A camera gets `AccessoryInformation`, a `MotionSensor` with subtype `motion`, and one `MotionSensor` per **enabled** smart-detect type
- [ ] Only types present in `smartDetectSettings.objectTypes` produce a sensor — a supported-but-disabled type does not
- [ ] `alrmSmoke` in `smartDetectSettings.audioTypes` produces a `SmokeSensor`; `alrmCmonx` produces a `CarbonMonoxideSensor`; neither appears when the array is empty
- [ ] A camera with `hasSpeaker` and a doorbell-capable model gets a `Doorbell` service with subtype `ring`
- [ ] Re-running the builder with the same device is idempotent — no duplicate services
- [ ] Disabling a type removes exactly that service and leaves the others intact
- [ ] `applyChange` sets `MotionDetected`, `SmokeDetected`, `CarbonMonoxideDetected` or fires `ProgrammableSwitchEvent` as appropriate, and ignores an unknown subtype without throwing

**Verify:** `npx vitest run test/camera.test.ts` → all passing

**Steps:**

- [ ] **Step 1: Write `test/camera.test.ts` first**

`desiredSubtypes` is pure, so start there — it pins the whole "only enabled types
appear" decision without touching HAP:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { desiredSubtypes } from '../src/accessories/camera.js'

const cameras = JSON.parse(readFileSync('test/fixtures/cameras.json', 'utf8'))
const byName = (n: string) => cameras.find((c: { name: string }) => c.name === n)

describe('desiredSubtypes', () => {
  it('exposes only the detection types enabled on each real camera', () => {
    expect(desiredSubtypes(byName('Doorbell')).sort()).toEqual(
      ['detect-animal', 'detect-package', 'detect-person', 'detect-vehicle', 'led', 'motion', 'ring'].sort())
    // Backyard supports vehicle but has it disabled in Protect, so no Vehicle sensor.
    expect(desiredSubtypes(byName('Backyard'))).not.toContain('detect-vehicle')
    expect(desiredSubtypes(byName('Backyard'))).toContain('detect-person')
  })

  it('omits the LED switch on a camera without a status LED', () => {
    expect(desiredSubtypes(byName('Sidegate'))).not.toContain('led')
    expect(desiredSubtypes(byName('Garage'))).toContain('led')
  })

  it('only the doorbell gets a ring service', () => {
    expect(desiredSubtypes(byName('Doorbell'))).toContain('ring')
    for (const n of ['Backyard', 'Driveway', 'Sidegate', 'Garage'])
      expect(desiredSubtypes(byName(n)), n).not.toContain('ring')
  })

  it('audio sensors appear only once enabled in Protect', () => {
    const camera = { ...byName('Garage'), smartDetectSettings: { objectTypes: ['person'], audioTypes: ['alrmSmoke', 'alrmBark'] } }
    const subtypes = desiredSubtypes(camera)
    expect(subtypes).toContain('audio-alrmSmoke')
    // Bark has no native HomeKit service and must not be exposed.
    expect(subtypes).not.toContain('audio-alrmBark')
  })

  it('tolerates a degraded payload with fields missing', () => {
    expect(() => desiredSubtypes({ id: 'x' })).not.toThrow()
    expect(desiredSubtypes({ id: 'x' })).toEqual(['motion'])
  })
})
```

Then the HAP-touching cases. `test/platform.test.ts` already builds a fake `api` with
`hap.uuid.generate` — extend that fake with the `Service` and `Characteristic` namespaces
plus an accessory implementing `getService`/`getServiceById`/`addService`/`removeService`
and a `services` array. Cover: an initial build produces exactly the `desiredSubtypes` set;
a second build with the same device adds nothing; a build with a type removed from
`objectTypes` removes exactly that service and leaves the rest; each `applyChange` branch
sets the right characteristic; and an unknown subtype is ignored without throwing.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/camera.test.ts`
Expected: FAIL — cannot resolve `../src/accessories/camera.js`.

- [ ] **Step 3: Write `src/accessories/camera.ts`**

```ts
import type { API, Logging, PlatformAccessory, Service } from 'homebridge'
import type { SensorChange } from './tracker.js'

/** Labels shown in Home.app, one per stable subtype. */
export const SUBTYPE_LABELS: Record<string, string> = {
  'motion': 'Motion',
  'detect-person': 'Person',
  'detect-vehicle': 'Vehicle',
  'detect-animal': 'Animal',
  'detect-package': 'Package',
  'detect-licensePlate': 'License Plate',
  'detect-face': 'Face',
  'audio-alrmSmoke': 'Smoke Alarm',
  'audio-alrmCmonx': 'CO Alarm',
  'ring': 'Doorbell',
}

/** Audio detections that have a native HomeKit service. */
const AUDIO_SERVICE = new Set(['audio-alrmSmoke', 'audio-alrmCmonx'])

export interface CameraCallbacks {
  setLed: (deviceId: string, on: boolean) => Promise<void>
}

/**
 * A degraded payload is returned raw when Zod validation fails, so a field the
 * type says exists may be absent at runtime. Every read here tolerates that.
 */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** The subtypes this device should expose, given what is enabled in Protect. */
export function desiredSubtypes(device: Record<string, unknown>): string[] {
  const settings = record(device.smartDetectSettings)
  const flags = record(device.featureFlags)
  const out = ['motion']

  for (const type of stringArray(settings.objectTypes)) {
    const subtype = `detect-${type}`
    // Only types with a label are exposed; an unknown type from a firmware
    // update is ignored rather than producing an unnamed service.
    if (SUBTYPE_LABELS[subtype] && !out.includes(subtype))
      out.push(subtype)
  }
  for (const type of stringArray(settings.audioTypes)) {
    const subtype = `audio-${type}`
    if (AUDIO_SERVICE.has(subtype) && !out.includes(subtype))
      out.push(subtype)
  }
  // Only a doorbell has a speaker on this hardware; a ring event cannot arrive
  // from a camera without one.
  if (flags.hasSpeaker === true)
    out.push('ring')
  if (flags.hasLedStatus === true)
    out.push('led')

  return out
}

function serviceTypeFor(api: API, subtype: string) {
  const { Service: S } = api.hap
  if (subtype === 'ring')
    return S.Doorbell
  if (subtype === 'led')
    return S.Switch
  if (subtype === 'audio-alrmSmoke')
    return S.SmokeSensor
  if (subtype === 'audio-alrmCmonx')
    return S.CarbonMonoxideSensor
  return S.MotionSensor
}

export function buildCameraServices(
  api: API,
  log: Logging,
  accessory: PlatformAccessory,
  device: Record<string, unknown>,
  callbacks: CameraCallbacks,
): void {
  const { Characteristic: C, Service: S } = api.hap
  const label = typeof device.name === 'string' && device.name.trim() ? device.name.trim() : 'Camera'

  const info = accessory.getService(S.AccessoryInformation) ?? accessory.addService(S.AccessoryInformation)
  info.setCharacteristic(C.Manufacturer, 'Ubiquiti')
    .setCharacteristic(C.Model, typeof device.modelKey === 'string' ? device.modelKey : 'camera')
    .setCharacteristic(C.SerialNumber, typeof device.mac === 'string' ? device.mac : String(device.id ?? 'unknown'))

  const desired = desiredSubtypes(device)

  for (const subtype of desired) {
    const type = serviceTypeFor(api, subtype)
    const name = subtype === 'led' ? `${label} Status LED` : `${label} ${SUBTYPE_LABELS[subtype]}`
    let service = accessory.getServiceById(type, subtype)
    if (!service) {
      service = accessory.addService(type, name, subtype)
      log.debug(`Added ${subtype} service to "${label}".`)
    }
    service.setCharacteristic(C.ConfiguredName, name)

    if (subtype === 'led') {
      const enabled = record(device.ledSettings).isEnabled === true
      service.updateCharacteristic(C.On, enabled)
      const characteristic = service.getCharacteristic(C.On)
      // Re-registering would stack handlers on every rebuild.
      characteristic.removeAllListeners('set')
      characteristic.onSet(async (value) => {
        const previous = characteristic.value
        try {
          await callbacks.setLed(String(device.id), Boolean(value))
        }
        catch (error) {
          // Protect rejected it — HomeKit must not keep showing the new state.
          log.warn(`Could not change the status LED on "${label}": ${(error as Error).message}`)
          service!.updateCharacteristic(C.On, previous)
        }
      })
    }
  }

  // Removal is destructive, so it runs only from a confirmed successful
  // discovery — the caller in platform.ts guarantees that.
  for (const service of [...accessory.services]) {
    const subtype = service.subtype
    if (!subtype || desired.includes(subtype))
      continue
    accessory.removeService(service)
    log.info(`Removed ${subtype} from "${label}" — no longer enabled in Protect.`)
  }
}

export function applyChange(api: API, accessory: PlatformAccessory, change: SensorChange): void {
  const { Characteristic: C } = api.hap
  const type = serviceTypeFor(api, change.subtype)
  const service: Service | undefined = accessory.getServiceById(type, change.subtype)
  if (!service)
    return

  if (change.subtype === 'ring') {
    // Stateless: a ring fires once and has nothing to clear.
    if (change.active)
      service.updateCharacteristic(C.ProgrammableSwitchEvent, C.ProgrammableSwitchEvent.SINGLE_PRESS)
    return
  }
  if (change.subtype === 'audio-alrmSmoke') {
    service.updateCharacteristic(C.SmokeDetected, change.active ? C.SmokeDetected.SMOKE_DETECTED : C.SmokeDetected.SMOKE_NOT_DETECTED)
    return
  }
  if (change.subtype === 'audio-alrmCmonx') {
    service.updateCharacteristic(C.CarbonMonoxideDetected, change.active ? C.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL : C.CarbonMonoxideDetected.CO_LEVELS_NORMAL)
    return
  }
  service.updateCharacteristic(C.MotionDetected, change.active)
}
```

Note `desiredSubtypes` is exported separately so Task 4 and the tests can assert the
expected service set without constructing HAP objects.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/camera.test.ts && npx tsc --noEmit`
Expected: all passing, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/accessories/camera.ts test/camera.test.ts
git commit -m "feat(accessories): camera sensor service builder"
```

---

### Task 4: Wire the event pipeline into the platform

**Goal:** Connect `protectEvent` → router → tracker → builder, and build services during reconcile.

**Files:**
- Modify: `src/platform.ts`
- Test: `test/platform.test.ts` (extend)

**Acceptance Criteria:**
- [ ] `protectEvent` frames reach the router and drive the matching accessory's services
- [ ] An event for an unknown device id is ignored silently
- [ ] A malformed event frame does not throw out of the handler
- [ ] `resyncRequired` calls `tracker.clearAll()` and applies the resulting changes
- [ ] The tracker's failsafe callback applies changes to services
- [ ] `shutdown` calls `tracker.stop()`
- [ ] Services are built during `reconcile` for every exposed camera, and rebuilt when the device payload changes
- [ ] Service removal happens only on a confirmed successful discovery — never on a degraded one

**Verify:** `npx vitest run test/platform.test.ts && npm run build` → all passing

**Steps:**

- [ ] **Step 1: Write the failing tests**

Extend `test/platform.test.ts`. The file already has `mkApi()` and a client helper — reuse them. The pattern for every case:

```ts
it('drives a motion sensor from a protectEvent frame', async () => {
  const a = mkApi()
  const p = new UniFiProtectPlatform(log as never, cfg as never, a as never)
  const bus = Object.assign(new EventEmitter(), { start: vi.fn(), stop: vi.fn() })
  p.client = makeClient([{ id: 'cam1', name: 'Doorbell', modelKey: 'camera', featureFlags: {}, smartDetectSettings: { objectTypes: ['person'] } }]) as never
  p.events = bus as never
  await p.discover()

  const accessory = p.accessories.get('uuid-cam1')!
  const motion = accessory.getServiceById(a.hap.Service.MotionSensor, 'motion')!

  bus.emit('protectEvent', { type: 'add', item: { id: 'e1', device: 'cam1', type: 'motion', start: 1, end: null } })
  expect(motion.getCharacteristic(a.hap.Characteristic.MotionDetected).value).toBe(true)

  bus.emit('protectEvent', { type: 'update', item: { id: 'e1', device: 'cam1', type: 'motion', start: 1, end: 2 } })
  expect(motion.getCharacteristic(a.hap.Characteristic.MotionDetected).value).toBe(false)
})
```

Then the remaining cases, each following the same shape:
- an event with `device: 'nope'` changes no characteristic and does not throw
- `bus.emit('protectEvent', null)` and `{ item: { type: 5 } }` do not throw
- after a `start` frame, emitting `resyncRequired` clears the sensor
- a degraded discovery (the existing helper that returns a non-array payload) removes no services from an existing accessory
- `a.emit('shutdown')` then advancing timers past the failsafe fires nothing

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/platform.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Wire it up in `src/platform.ts`**

In `startEvents()`, alongside the existing `deviceUpdate` and `resyncRequired` listeners, add:

```ts
this.events.on('protectEvent', (frame: unknown) => this.applyProtectEvent(frame))
```

and extend the existing `resyncRequired` handler to clear the tracker before triggering discovery. Add:

```ts
/** Frames arrive unvalidated. Nothing in here may throw back into the socket. */
private applyProtectEvent(frame: unknown): void {
  try {
    const routed = routeEvent(frame)
    if (!routed)
      return
    const accessory = this.accessories.get(this.api.hap.uuid.generate(routed.deviceId))
    // Unknown device: not adopted, or the user set expose: false.
    if (!accessory)
      return
    for (const change of this.tracker.apply(routed))
      applyChange(this.api, accessory, change)
  }
  catch (error) {
    this.log.warn(`Discarding an event frame that could not be handled: ${(error as Error).message}`)
  }
}
```

Construct the tracker in the constructor with `onFailsafe` wired to the same apply loop, and call `this.tracker.stop()` in the shutdown handler next to the existing cleanup.

In `reconcile`, call `buildCameraServices` for each camera being kept — both newly created and existing accessories — so a capability change is picked up.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/platform.test.ts && npx tsc --noEmit && npm run build`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/platform.ts test/platform.test.ts
git commit -m "feat: drive camera sensors from the protect event stream"
```

---

### Task 5: Status LED switch

**Goal:** A Switch per camera that reads `ledSettings.isEnabled` and writes it back to Protect.

**Files:**
- Modify: `src/accessories/camera.ts`, `src/platform.ts`
- Test: `test/camera.test.ts` (extend)

**Acceptance Criteria:**
- [ ] Every camera with `featureFlags.hasLedStatus` gets a `Switch` with subtype `led`; Sidegate (which reports `hasLedStatus: false`) does not
- [ ] The switch reflects `ledSettings.isEnabled` from the device payload
- [ ] A `deviceUpdate` frame changing `ledSettings.isEnabled` updates the switch, so a change made in the Protect app appears in HomeKit
- [ ] Setting the switch calls `patchCamera` with `{ledSettings: {isEnabled: value}}`
- [ ] A failed write reverts the characteristic to its previous value and logs a warning — HomeKit must not show a state Protect rejected

**Verify:** `npx vitest run test/camera.test.ts` → all passing

**Steps:**

- [ ] **Step 1: Write the failing tests**

The revert-on-failure case is the one worth pinning precisely, because a silent
success is indistinguishable from a real one in Home.app:

```ts
it('reverts the switch when Protect rejects the write', async () => {
  const api = mkApi()
  const accessory = new api.platformAccessory('Doorbell', 'uuid-cam1')
  const setLed = vi.fn(async () => { throw new Error('403 Forbidden') })
  const device = { id: 'cam1', name: 'Doorbell', modelKey: 'camera',
    featureFlags: { hasLedStatus: true }, ledSettings: { isEnabled: true } }

  buildCameraServices(api as never, log as never, accessory as never, device, { setLed })
  const service = accessory.getServiceById(api.hap.Service.Switch, 'led')!
  const on = service.getCharacteristic(api.hap.Characteristic.On)
  expect(on.value).toBe(true)

  await on.handleSetRequest(false).catch(() => {})
  expect(setLed).toHaveBeenCalledWith('cam1', false)
  // Protect refused, so HomeKit must go back to showing the real state.
  expect(on.value).toBe(true)
  expect(log.warn).toHaveBeenCalled()
})
```

Then: the switch is present for every camera with `hasLedStatus: true` and absent for
Sidegate (`hasLedStatus: false` in the fixture); the initial value matches
`ledSettings.isEnabled`; a successful set calls `patchCamera` with exactly
`{ ledSettings: { isEnabled: false } }`; and a `deviceUpdate` frame changing
`ledSettings.isEnabled` updates the characteristic without a write.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/camera.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

Add the Switch to `buildCameraServices` behind `featureFlags.hasLedStatus`. Wire `onSet` through a callback the platform supplies, so `camera.ts` does not need the client:

```ts
export interface CameraCallbacks {
  setLed: (deviceId: string, on: boolean) => Promise<void>
}
```

The platform supplies `setLed` as `(id, on) => this.client.patchCamera(id, { ledSettings: { isEnabled: on } })`. On rejection, revert:

```ts
.onSet(async (value) => {
  const previous = service.getCharacteristic(api.hap.Characteristic.On).value
  try {
    await callbacks.setLed(device.id, Boolean(value))
  }
  catch (error) {
    // Protect rejected it — HomeKit must not keep showing the new state.
    log.warn(`Could not change the status LED on "${label}": ${(error as Error).message}`)
    service.updateCharacteristic(api.hap.Characteristic.On, previous)
  }
})
```

Extend `applyDeviceUpdate` in `platform.ts` so a merged `ledSettings` change refreshes the switch.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/camera.test.ts && npm run build`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/accessories/camera.ts src/platform.ts test/camera.test.ts
git commit -m "feat(accessories): status LED switch"
```

---

### Task 6: Live verification on real Homebridge

**Goal:** Prove on the user's actual Homebridge instance that sensors fire, the doorbell rings, and the LED switch works.

> **USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

**Acceptance Criteria:**
- [ ] The plugin is installed on the user's Homebridge at `192.168.1.50:8581` and loads without error
- [ ] Each camera shows a Motion sensor plus one sensor per enabled detection type in Home.app; Backyard and Sidegate show no Vehicle sensor
- [ ] Walking past a camera trips both its Motion and its Person sensor, and both clear on their own without a fixed timer
- [ ] Pressing the doorbell fires the Doorbell in Home.app
- [ ] Toggling the status LED switch visibly changes the LED on the real camera
- [ ] Changing the LED in the Protect app updates the switch in HomeKit
- [ ] `README.md` documents the known ceilings: no state at startup, resync clears active events, audio detection inert until enabled
- [ ] `CHANGELOG.md` has a `0.2.0` entry describing sensors and the LED switch

**Verify:** Homebridge debug log shows sensor transitions; the user confirms Home.app behaviour for motion, doorbell and LED

**Steps:**

- [ ] **Step 1: Build and install**

Run `npm run build`, then install the plugin on the Homebridge instance. Homebridge debug logging is already enabled there, so the log will show the plugin's `debug` lines.

- [ ] **Step 2: Confirm the accessory and service inventory**

Check the Homebridge log for the discovery line and confirm 6 devices. Then confirm in Home.app that each camera shows the expected sensors, and specifically that Backyard and Sidegate have no Vehicle sensor — that is the "only enabled types appear" decision made visible.

- [ ] **Step 3: Trigger and observe each behaviour**

Ask the user to walk past a camera and press the doorbell. Capture the Homebridge log lines showing the sensor going active and then clearing. Toggle the LED switch and confirm the physical LED. Change the LED in the Protect app and confirm HomeKit follows.

- [ ] **Step 4: Write the docs**

Add the ceilings to `README.md` verbatim from the spec's "Known ceilings" section, and a `0.2.0` entry to `CHANGELOG.md` under Keep a Changelog covering: motion sensors, per-type smart-detect sensors, doorbell, smoke/CO sensors when enabled, and the status LED switch.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: camera sensors and controls for 0.2.0"
```

---

## Definition of done

1. `npm run lint`, `npm test`, `npm run build` pass; `npm run live-check` still 11/11.
2. Real event fixtures captured from hardware and committed, redacted.
3. Every camera shows a Motion sensor plus one sensor per enabled detection type in Home.app.
4. The Doorbell rings in Home.app when pressed.
5. Walking past a camera trips both Motion and Person, and both clear without a fixed timer.
6. The status LED switch changes the real LED, and reflects a change made in the Protect app.
7. Disabling a detection type in Protect removes its sensor on the next discovery; a degraded discovery removes nothing.
