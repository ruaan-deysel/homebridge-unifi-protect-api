# Sub-project 2a: Camera sensors and controls — Design

**Date:** 2026-07-31
**Status:** Approved
**Depends on:** sub-project 1 (foundation), merged at `e124c71`
**Parent design:** `2026-07-31-unifi-protect-api-design.md`

## Problem

The foundation registers one HomeKit accessory per Protect device, but every accessory is
empty — no services. Cameras appear in Home.app as blank tiles. This sub-project gives them
sensors and one control, so the cameras become useful in HomeKit automations without any
video work.

## Scope

**In:** motion sensors, per-type smart-detect sensors, doorbell ring, smoke and CO sensors
from audio detection, and a status-LED switch.

**Out, deliberately:**

- **Live streaming, snapshots and talkback** — sub-project 2b. All the difficulty is there:
  ffmpeg process management, SRTP, HomeKit stream negotiation. Keeping it separate means 2a
  ships with zero ffmpeg risk.
- **HomeKit Secure Video** — sub-project 3.
- **PTZ** — dropped entirely. All five cameras report `activePatrolSlot: null` and none are
  PTZ models. The original decomposition listed it; building it would be speculative work
  for hardware the user does not own.
- **Every camera control except the status LED.** See "Controls" below.

## Verified hardware baseline

Probed against the live UDM-Pro, Protect 7.1.87. This is what the design is built on, not
what the spec promises.

| Camera | Speaker | Package cam | LED | Smart detect enabled |
| --- | --- | --- | --- | --- |
| Doorbell | yes | yes | yes | person, vehicle, animal, package |
| Backyard | no | no | yes | person, animal |
| Driveway | no | no | yes | person, vehicle, animal |
| Sidegate | no | no | no | person, animal |
| Garage | no | no | yes | person, vehicle, animal |

Audio detection is **supported on all five and enabled on none** (`audioTypes: []`).

Note Backyard and Sidegate have `vehicle` supported but not enabled — so they get no Vehicle
sensor until the user enables it in the Protect app. This is the intended behaviour, not an
oversight.

### Event model, from the vendored OpenAPI spec

Every event carries `id`, `modelKey`, `type`, `start`, `end` (nullable), and `device`. The
envelope is `{ type: 'add' | 'update', item: event }`.

| Event type | Carries | Drives |
| --- | --- | --- |
| `motion` | — | generic Motion sensor |
| `smartDetectZone` | `smartDetectTypes[]` | per-type sensors |
| `smartDetectLine` | `smartDetectTypes[]` | per-type sensors |
| `smartDetectLoiterZone` | `smartDetectTypes[]` | per-type sensors |
| `smartAudioDetect` | `smartDetectTypes[]` | Smoke / CO sensors |
| `ring` | — | Doorbell |

Smart detect types: `person`, `vehicle`, `package`, `licensePlate`, `face`, `animal`.
Audio types include `alrmSmoke`, `alrmCmonx`, `alrmSiren`, `alrmBabyCry`, `alrmSpeak`,
`alrmBark`, `alrmBurglar`, `alrmCarHorn`, `alrmGlassBreak`.

**`end: null` means in progress.** An `update` frame carrying a non-null `end` ends it. The
console therefore tells us when motion stops, which is why this design needs no arbitrary
reset timer — unlike most camera plugins, which trigger and then clear after a fixed delay.

**There is no REST endpoint for events.** `GET /v1/events` returns 404; events are
WebSocket-only. This is load-bearing for the recovery design below: active events cannot be
queried, only inferred.

## Service shape

Per camera accessory:

| Service | Subtype | Source |
| --- | --- | --- |
| `AccessoryInformation` | — | camera payload: Ubiquiti, model, serial = MAC, firmware |
| `MotionSensor` "Motion" | `motion` | `motion` events |
| `MotionSensor` per enabled type | `detect-<type>` | `smartDetectZone` / `Line` / `LoiterZone` |
| `Doorbell` | `ring` | `ring` events — Doorbell camera only |
| `SmokeSensor` | `audio-alrmSmoke` | `smartAudioDetect`, only if enabled in Protect |
| `CarbonMonoxideSensor` | `audio-alrmCmonx` | `smartAudioDetect`, only if enabled in Protect |
| `Switch` "Status LED" | `led` | `ledSettings.isEnabled` |

Subtypes are stable strings derived from the detection type, never from an array index, so a
user enabling a new detection type cannot reshuffle existing services.

On this hardware: 19 sensor services, 1 doorbell, 5 switches, across 5 accessories.

### Detections arrive on three channels and must be merged

`smartDetectZone`, `smartDetectLine` and `smartDetectLoiterZone` can all fire for one person
walking past. Each carries a `smartDetectTypes` array. Sensors are therefore keyed on
**detection type**, not on event channel — the Person sensor is driven by the union of all
three. One person must produce one trigger, not three.

### Audio detection maps only where HomeKit has a real equivalent

`alrmSmoke` becomes a `SmokeSensor` and `alrmCmonx` a `CarbonMonoxideSensor`. Both carry
genuine safety value: a camera hearing a smoke alarm can drive HomeKit lights and
notifications. The remaining audio types (bark, car horn, glass break, baby cry, speaking)
have no sensible native mapping and are not exposed. Since audio detection is disabled on
every camera today, these services will not appear until the user enables them in Protect.

## Controls

**Only the status LED.** One `Switch` per camera, writing `ledSettings.isEnabled`.

Every control is a write into Protect, and a misfiring HomeKit automation could change
settings across all five cameras. The status LED is the control people actually reach for —
turning off the blue ring at night — and nothing an automation can do to it matters. The
other writable fields are deliberately not exposed:

- `hdrType` has three states (`auto`/`on`/`off`); a Switch would silently collapse one.
- `micVolume` is 1–100 and would have to be a Lightbulb abusing brightness. Note
  `isMicEnabled` is **read-only** in this API, so a microphone on/off switch is not possible
  at all.
- `videoMode` is a six-value enum with no HomeKit shape.
- `smartDetectSettings` would let an automation disable detection — exactly the accident this
  design avoids.
- `lcdMessage`, `osdSettings`, `name` — no compelling automation use.

More can be added later. Starting minimal is reversible; starting broad is not.

## Event routing and state

### The router is pure

A single synchronous function: event in, a list of `(accessoryUUID, subtype, state)` updates
out. No HomeKit objects, no timers, no network. One event can produce several updates — a
`smartDetectZone` carrying `["person","vehicle"]` sets both sensors.

This purity is the entire testing strategy. Every case is coverable from fixtures.

### State lives in one map

`Map<eventId, ActiveEvent>`, holding the affected subtypes and a failsafe timer. State is
deliberately **not** held on the services, because two overlapping events can hold the same
sensor on, and it must only clear when both have ended.

### Three ways an event ends, in priority order

1. **The console says so.** An `update` frame with a non-null `end`. The normal path.
2. **A resync clears everything.** The foundation established that frames are lost while a
   socket is down, and there is no REST endpoint to query active events. On `resyncRequired`
   every open event is assumed ended. Slightly eager, but a sensor stuck on indefinitely is
   worse than one cleared early.
3. **A failsafe timer**, default 2 minutes per event, configurable. Covers a socket that
   stays up while the end frame is simply never delivered.

### Edge cases that must be handled

- **An `add` frame carrying a non-null `end`** — a very short detection that started and
  finished between frames. Fires a momentary on-then-off rather than being ignored.
- **A ring is stateless.** `ringEvent` fires `ProgrammableSwitchEvent`; there is nothing to
  turn off and no failsafe needed.
- **An unknown `smartDetectTypes` value** from a firmware update is ignored with a
  warn-once, never thrown. Consistent with the foundation's degrade-don't-throw rule.
- **An event for an unknown device id** is ignored silently — it may be a device the user has
  set `expose: false`.

## Capability diffing

The foundation deferred this because there were no services to diff. It lands here.

On each **successful** discovery, the set of enabled detection types per camera is compared
against the services actually built, and services are added or removed to match. Disabling
Vehicle detection on Driveway in the Protect app removes its Vehicle sensor on the next
discovery.

**Service removal reuses the accessory-removal safety rules**, because it is the same
destructive class: it happens only on a discovery confirmed successful, never on a degraded
or partial one. The foundation's history here is the reason — a degraded discovery
unregistering accessories was the worst defect found in sub-project 1, and it took three
rounds to close properly.

## Known ceilings

Accepted, and to be stated in the README rather than hidden.

- **No state at startup.** If the plugin starts while a motion event is already in progress,
  that sensor reads off until the next event. Protect offers no active-events query and there
  is no polling anywhere in this plugin. Inventing a fake initial state would be worse.
- **Resync clears active events eagerly.** A motion event genuinely in progress across a
  socket reconnect will read as ended. It will re-trigger on the next event.
- **Audio detection ships inert** on this hardware until enabled in the Protect app.

## Testing

### Fixtures come from real hardware, not from the spec

The foundation carries a known gap: *the devices-channel frame shape is inferred from tests,
not observed live.* Building 2a on inferred shapes would repeat that mistake one layer up.

**The plan opens with a capture task.** A listener runs while the user walks past a camera
and presses the doorbell — roughly two minutes of their time. It produces real `motion`,
`smartDetectZone`, `ring` payloads and their `update` end-frames, with actual field values.
Every subsequent test is built on those. A 45-second capture during design produced exactly
one frame (a chime update), which is why this cannot be done unattended.

Fixtures are redacted consistently, as in sub-project 1: the same real id maps to the same
fake id everywhere, so cross-references stay intact.

### Coverage

Unit tests against the pure router: every detection type, multi-type events, overlapping
events on one sensor, `add` with non-null `end`, unknown types, malformed payloads, all three
ending paths, and capability diffing in both directions.

**Every new test is mutation-checked** — reverted against a deliberately wrong implementation
to confirm it fails. Sub-project 1 caught several vacuous tests, including one that passed
because it asserted the mock's own behaviour rather than the code's, and a 73-mutant run
showed the suite was thin precisely where nothing had broken yet. Service creation and
removal here is exactly that kind of code.

### Three layers of verification

1. **Unit tests** against real captured fixtures.
2. **A live-hardware script** confirming the router produces the right updates from a real
   event as it happens.
3. **Installed on the user's Homebridge**, confirming in Home.app that walking past the
   Driveway camera trips Motion and Person, and that the doorbell rings.

Layer 3 is the honest gate. The first two prove the code does what the design thinks Protect
sends; only Home.app proves it works.

## Definition of done

1. `npm run lint`, `npm test`, `npm run build` pass; `npm run live-check` still 11/11.
2. Real event fixtures captured from hardware and committed, redacted.
3. Every camera shows a Motion sensor plus one sensor per enabled detection type in Home.app.
4. The Doorbell rings in Home.app when pressed.
5. Walking past a camera trips both its Motion and its Person sensor, and both clear on their
   own without a fixed timer.
6. The status LED switch changes the LED on the real camera, and reflects a change made in
   the Protect app.
7. Disabling a detection type in Protect removes its sensor on the next discovery; a degraded
   discovery removes nothing.
