# Sub-project 2b — Live streaming and snapshots

Status: approved 2026-08-01. Follows sub-project 2a (camera sensors), merged to `main` at `ebaf158`.

## Goal

Give every camera a working live view and snapshot in HomeKit, using hardware transcoding
where the host supports it and degrading to software where it does not.

Talkback is **out of scope** and becomes sub-project 2c. Only the Doorbell has a speaker, and
two-way audio is roughly as much work as live streaming itself — bundling them would make the
four cameras that cannot talk back wait on the one that can.

HKSV remains sub-project 3.

## Why transcoding is unavoidable

Every Protect stream is HEVC. HomeKit accepts only H.264. There is no stream-copy path, so
every live view costs a decode and an encode. That single fact drives the whole design.

## Verified hardware facts

Measured against the live console and the running Homebridge container on 2026-08-01. These
override any documentation; the vendor's OpenAPI spec has now been wrong on this hardware
five times.

**Substreams** (Driveway, representative):

| Quality | Resolution | Codec |
|---------|------------|-------|
| high    | 2688×1512  | HEVC Main, 30 fps |
| medium  | 1280×720   | HEVC Main, 30 fps |
| low     | 640×360    | HEVC Main, 30 fps |

`POST /cameras/{id}/rtsps-stream` returns 200 with all three URLs. Protect reports `null` for
a quality until a stream has been created this way, so URLs must be created before use.

**Audio.** The high stream carries two tracks: `aac (LC) 16 kHz mono` and `opus 48 kHz
stereo`. All five cameras report `hasMic: true`. Only the Doorbell reports `hasSpeaker: true`.

**`hasPackageCamera` is `undefined` on every camera** — the Integration API does not expose it.
Do not design around a package camera; it cannot be detected through this API.

**Host** (unraid): Intel i7-8700K, UHD Graphics 630, `i915` loaded, `/dev/dri/renderD128` and
`/dev/dri/card0` present.

**Container** (`homebridge/homebridge:latest`): Ubuntu 24.04 — *not* Alpine, despite its
bundled ffmpeg being named `8.0-homebridge-alpine-x86_64-static`. That ffmpeg advertises
exactly one hwaccel, `amf` (AMD), and its H.264 encoders are `libx264`, `h264_amf`,
`h264_v4l2m2m`. **No `h264_qsv`, no `h264_vaapi`.** `/dev/dri` is not passed into the
container (`HostConfig.Devices` is empty).

So hardware transcoding is currently impossible for two independent reasons: the device is
absent, and the bundled ffmpeg could not use it if it were present. Both must be fixed.

`intel-media-va-driver-non-free` (24.1.0) and `ffmpeg` (7:6.1.1-3ubuntu5) are installable from
the container's own apt repositories. **Not yet verified: whether that ffmpeg build actually
carries VAAPI and QSV encoders** — only its availability was confirmed. Confirming it is part
of the first implementation task, because if it does not, a different ffmpeg build must be
sourced and the environment prerequisite changes.

`/mnt/user/appdata/homebridge/startup.sh` is the hook the image runs at container start, and is
where the install belongs so it survives image updates.

## Environment prerequisite

Enabling hardware transcoding is a change to the user's Docker container, not to this plugin:

1. Add `--device=/dev/dri:/dev/dri` to the container. **This requires recreating the
   container** — Homebridge restarts and every accessory briefly drops.
2. Install `intel-media-va-driver-non-free` from `startup.sh`.

The plugin installs nothing and requires none of this. It detects what is available and uses
the best path, so it works unchanged on a Raspberry Pi with no QuickSync at all.

## Architecture

Three new modules, following the isolation the sensor pipeline uses: each has one purpose, a
narrow interface, and is testable without the others.

### `src/protect/ffmpeg.ts`

Capability probe and process supervision.

At startup, runs `ffmpeg -hwaccels` and `ffmpeg -encoders` **once** and caches the result.
Chooses an encoder in this order:

1. `h264_qsv`
2. `h264_vaapi`
3. `libx264`

Logs which was chosen. That log line is the user's only signal that `/dev/dri` is not reaching
the container — a silent fall back to software looks identical to success, only slower.

This module is the sole owner of subprocess spawning, killing and reaping. Nothing else in the
codebase spawns a process.

### `src/protect/stream.ts`

RTSPS URL acquisition. Creates streams via `POST /cameras/{id}/rtsps-stream` and caches URLs
per camera and quality. Pure I/O against the existing client; knows nothing about ffmpeg.

### `src/accessories/streaming.ts`

The HAP `CameraStreamingDelegate`. Translates a HomeKit request (resolution, fps, bitrate,
SRTP keys) into a substream choice and an ffmpeg invocation, and tracks live sessions for
teardown. Knows nothing about how ffmpeg was built or how URLs are obtained.

### `src/platform.ts`

Gains `configureController(CameraController)` per camera accessory. The existing
`OWNED_SUBTYPES` allow-list in `camera.ts` already protects these services from the sensor
code's removal loop — that allow-list was built in 2a for exactly this case, and streaming
services must **not** be added to it.

## Substream selection

| HomeKit requests | Substream used | Scaling |
|------------------|----------------|---------|
| ≤ 640×360        | low            | none    |
| ≤ 1280×720       | medium         | none    |
| larger           | high           | downscale |

HomeKit's most common request is 1280×720, which maps to a substream needing no scaling at
all — only the mandatory HEVC→H.264 transcode.

Per-camera config: `quality: auto | low | medium | high`, default `auto`. Cameras are not
equal — a driveway may warrant plate-readable detail where a garage does not.

## Audio

**Off by default**, opt-in per camera.

Audio genuinely adds value on a doorbell, so it must be available. Defaulting it off is right
for a plugin others install: Australian surveillance-devices law treats audio far more
strictly than video and varies by state, several states require all-party consent for private
conversations, and outdoor cameras capture people who have not consented. This mirrors the
HKSV decision — capability present, enabled deliberately.

When enabled, audio is transcoded to AAC-ELD for HomeKit.

## Snapshots

`GET /cameras/{id}/snapshot` returns a JPEG, handed to HomeKit directly. **No ffmpeg.**
Spawning a process to capture one frame would be far slower and heavier, and this endpoint is
already verified working by `npm run live-check`.

Snapshots are cached for ~2 seconds: HomeKit polls them far more eagerly than expected, and
each request otherwise hits the console.

## Session lifecycle

- `prepareStream` allocates local RTP ports and returns SSRCs.
- `handleStreamRequest(start)` spawns ffmpeg reading RTSPS over TCP, emitting SRTP.
- `handleStreamRequest(stop)` kills the process and frees the session.
- A watchdog reaps sessions HomeKit never stopped. A stranded ffmpeg holding a 4 MP decode is
  considerably worse than the stranded timer the sensor tracker already guards against.

**Concurrency is capped** (default 4, configurable). Past the cap the plugin refuses with a
clear log rather than thrashing. The host runs other workloads; this ceiling protects them
too.

## The Doorbell service collision

`CameraController` creates its own Doorbell service when told the camera is a doorbell.
Sub-project 2a already added a subtyped `ring` Doorbell service, driven by the event pipeline.

**Keep the 2a service; do not ask `CameraController` for one.** Two Doorbell services on one
accessory makes the doorbell appear twice in Home.app. This was flagged during the 2a review
as a future trap and is resolved here.

## Security

**The RTSPS URL contains an authentication token.** This is a second credential class the
codebase has not previously handled, and it is easier to leak than the API key: **ffmpeg
echoes its full command line on failure by default**, so any naive stderr logging publishes
the token.

Rules, extending the existing API-key discipline:

- No RTSPS URL may reach a log line, an error message, a thrown `Error`, or a crash report —
  including via `util.inspect`, which is how Homebridge's `log.error(err)` prints.
- ffmpeg stderr must be redacted **before** logging, not filtered afterwards.
- The existing `errorMessage()` in `src/protect/errors.ts` is the only sanctioned path for
  turning an error into a loggable string.

## Testing

The most instructive failure in 2a was a bug invisible to mutation testing because **the code
and its tests shared a false premise** about a payload shape. Streaming has the same hazard in
a new place: ffmpeg's capability output.

**Capture task first**, mirroring 2a's Task 0: record real `ffmpeg -hwaccels` and `-encoders`
output from the container as fixtures, plus a second set from a host without QuickSync.
Capability parsing is then tested against text ffmpeg actually emits. That parsing decides
hardware versus software encoding, and getting it wrong fails silently — the plugin is merely
slow.

**Unit tested, no ffmpeg and no HAP:**

- substream selection — a pure function from requested resolution to quality, the direct
  analogue of `router.ts`
- capability parsing — real fixture in, encoder choice out
- ffmpeg argument construction — asserted as an exact array, so a wrong flag fails a test
  rather than a stream

**Injected at the boundary:** process spawning gets the same treatment as `HttpRequestFn` — an
injectable spawn function — so session lifecycle, cap enforcement and the watchdog are
testable without launching anything.

**Mandatory redaction test:** plant a sentinel token in an RTSPS URL, force an ffmpeg failure,
and assert the sentinel appears nowhere in any logged argument. This follows the pattern that
caught the API-key leak, and is load-bearing rather than ceremonial given ffmpeg's command-line
echo.

**Mutation-check every non-trivial test.** In 2a, mutation testing caught a vacuous test in
every single task, including one written specifically to catch a known bug. Reading diffs
caught none of them.

## Hardware gates

Two things tests cannot reach:

1. **Benchmark before building on the assumption.** Prove QSV transcodes the real 2688×1512
   HEVC stream faster than realtime on this host. If it does not, the concurrency design
   changes — and that must be known at the start, not after five tasks.
2. **A human in Home.app.** Viewing a camera is the only real proof. The Homebridge UI can be
   driven programmatically but does not render video.

## Carried forward

- **2c — talkback.** Doorbell only. Builds the two-way audio pipeline.
- **3 — HKSV.** Note the corrected iCloud limits: 50 GB supports 1 camera, 200 GB supports 5,
  2 TB and above unlimited; footage does not count against the storage quota.
- **4 — other device classes.** No lights, sensors or viewers exist on this system to test
  against.
