# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.3] - 2026-08-31

### Changed
- The vendored Protect API contract is regenerated from the **v7.2.105** OpenAPI 3.1 spec
  (was 7.1.87). The runtime API surface is unchanged, so this is purely a schema refresh; it
  removes the `/v1/cameras … did not match the expected schema` warning seen on consoles
  already running 7.2.105.
- Test fixtures are re-captured from a live 7.2.105 console and redacted (device GUIDs are
  now hashed too). The captured camera set reflects current hardware settings — Sidegate, for
  example, enabled only person detection, so tests assert the sensors actually built.
- The schema generator (`scripts/gen-zod.mjs`) now understands the `pattern` keyword (used by
  `posTransactionRequest.currency` in 7.2.105), maps it to a zod `.regex()`, and applies its
  `OPTIONAL_OVERRIDES` only at top-level components so a required-but-omitted field on real
  hardware (`camera.lcdMessage`) stays optional without leaking into nested objects.
- `scripts/live-check.mjs`, `capture-events.mjs` and the new `capture-fixtures.mjs` read
  `PROTECT_CERT_SHA256` from `.env` correctly (the key name contains digits; the previous
  `^([A-Z_]+)=` pattern silently skipped it).

### Added
- `scripts/capture-fixtures.mjs` — one-shot re-capture of the device fixtures from a live
  console, so future Protect firmware bumps can refresh `test/fixtures` the way
  `capture-events.mjs` already refreshes event fixtures.

## [1.0.2] - 2026-08-30

### Fixed
- Motion now fires on every camera, not only the doorbell. Protect 7.2.105 emits classic
  `motion` events only for doorbells; every other camera surfaces motion purely as smart-detect
  events, which the plugin routed solely to the per-type Person/Vehicle/Animal sensors — so the
  camera's Motion sensor, the tile HomeKit notifications, automations and HKSV key off, never
  fired. A smart-detect event now drives the camera's Motion sensor alongside its per-type
  sensors (verified against the live event stream: `smartDetectZone` frames for Driveway, Garage
  and Backyard while the Motion sensors stayed dark). A smart-detect event whose detection types
  cannot be read still triggers motion, and audio detections continue to drive only their
  smoke/CO sensors.

## [1.0.1] - 2026-08-06

### Security
- Certificate pinning now verifies the console's certificate explicitly during the TLS
  handshake instead of overriding `checkServerIdentity` with a no-op. The presented leaf
  must match the trusted certificate byte for byte, so identity is enforced in two
  independent layers (the pinned `ca` chain check, then the explicit compare) — resolving
  the static-analysis findings that flagged the override as disabling validation. Behaviour
  against real hardware is unchanged: the hostname mismatch of a UniFi console is still
  tolerated, and a genuinely wrong certificate is now surfaced with an
  `ERR_TLS_CERT_PIN_MISMATCH` code so the UI still reports it as a certificate error.
- The developer diagnostic scripts (`live-check`, `capture-events`) no longer trust a
  console certificate on first sight before sending the API key: they require an
  out-of-band `PROTECT_CERT_SHA256` fingerprint, printing the presented one when none is
  configured so it can be verified and set. They also pin every request to the read
  certificate and send SNI only for DNS hostnames.

## [1.0.0] - 2026-08-06

### Changed
- TypeScript is pinned to the 6.x line (`^6.0.3`), matching what Homebridge 2.2.1 itself
  builds against. npm's `latest` tag is now TypeScript 7, whose native compiler is too new
  to assume Homebridge supports it; the caret keeps 7 out.

### Added
- Protect floodlights are exposed as a HomeKit Lightbulb with brightness plus a motion
  sensor. On/off maps to the console's force-enable override, so toggling the light in
  HomeKit never overwrites its configured motion or schedule mode; brightness maps to the
  hardware's six LED levels. Both the light and its PIR update in realtime from the device
  event stream, and a change made in the Protect app is reflected in HomeKit.
- Chimes are exposed as a HomeKit Lightbulb whose brightness controls the ring volume
  (0-100), turning off to silence the chime. The volume applies to every doorbell the
  chime is paired to, preserving each ring's tone and repeat count, and updates in realtime
  from the device event stream.
- Motion sensors for every camera, driven by the live event stream rather than polling.
  `GET /v1/events` does not exist in the Integration API, so a lost end-frame can never be
  reconciled by a query — each active event carries a failsafe timer that clears it.
- Smart-detection sensors per camera, one per detection type enabled in Protect: person,
  vehicle, animal and package. A type that is supported but switched off produces no
  sensor, and switching it off later removes exactly that sensor.
- Smoke and carbon-monoxide sensors for cameras with audio detection enabled, mapped from
  Protect's `smartAudioDetect` alarms.
- A Doorbell service on cameras with a speaker, firing on a real `ring` event.
- A status-LED switch on cameras that have one, reflecting `ledSettings.isEnabled` and
  writing changes back to Protect. Changing the LED in the Protect app updates HomeKit,
  and a failed write restores the switch rather than leaving it showing a state the
  console rejected.
- Sensor state is reference-counted, so overlapping events cannot switch a sensor off
  early. The console redelivers end-frames — observed up to three times with an identical
  value — and duplicates are ignored.
- Live streaming video quality is automatically selected based on HomeKit's resolution
  request: 640×360 and below uses the low substream, 1280×720 uses medium, and anything
  larger uses high. Per-camera quality override allows pinning a substream instead.
- Live view transcoding now probes ffmpeg at startup and prefers Intel Quick Sync (QSV) or
  VAAPI hardware encoding over the bundled software encoder, since every Protect stream is
  HEVC and HomeKit only accepts H.264. Hardware encoding cuts CPU cost roughly 27× on
  supported hosts; the chosen ffmpeg path and encoder are logged so a silent fallback to
  software is visible rather than just running expensive.
- RTSPS stream URLs are now cached per camera and quality for 5 minutes, creating a
  stream on demand the first time a quality is requested. Protect reports no URL for a
  quality until one has been created that way, so this also prevents ffmpeg from being
  handed a stale, expired URL.
- Live view now works end to end: HomeKit's stream request picks the substream, fetches the
  RTSPS URL and transcodes it to H.264 for as long as the viewer is watching, and closing
  the view kills the transcode.
- Camera snapshots come straight from the console as JPEG — no ffmpeg is started for a
  snapshot — and are cached for two seconds, so the Home app's frequent thumbnail polling
  reaches the console once rather than once per tile. A failed snapshot is reported to
  HomeKit with the reason only, never the underlying request details.
- Concurrent live views are capped for the whole host rather than per camera: six with
  hardware encoding, two with software. Five cameras therefore share one budget instead of
  each getting its own, and a request past the cap is refused with a logged reason instead
  of overloading the machine.
- The package lens appears in HomeKit as its own camera, named "<camera> Package Camera",
  for cameras whose payload reports the lens (`hasPackageCamera`) and whose owner switched
  it on in the settings. It is bridged like every other accessory, is a camera and nothing
  else — the package motion sensor stays on the main accessory, so existing automations are
  untouched — and it advertises a range of 4:3 sizes and no audio. Its snapshots come from
  the package channel, so the tile shows the downward view rather than the main lens.
  Switching the setting off removes it again on the next discovery.
- The package lens transcode is scaled to whatever size HomeKit asks for, and its frame
  rate padded to the rate HomeKit negotiated, so every advertised size is one the plugin
  actually delivers. That path decodes in software and scales before handing the frame to
  the hardware encoder: scaling on the GPU fails outright on the reference host, and
  decoding this lens in software costs almost nothing because the console serves it at
  2 fps.
- The Doorbell's package lens can now be streamed like any other camera. It has one stream
  rather than a choice of substreams, and the console serves it at 1600×1200/2 fps rather
  than 16:9/30 fps like every other lens, so ffmpeg duplicates frames up to the rate
  HomeKit negotiated — without that, HomeKit can mistake a genuine 2 fps feed for a stalled
  stream. It never carries audio, since the lens shares its microphone with the main camera
  and a second identical audio source helps no one.
- Live view can carry audio, sent as its own stream alongside the video and transcoded to
  Opus, which HomeKit accepts and which the hardware-capable ffmpeg can encode. AAC-ELD is
  used instead when a build has `libfdk_aac` but not `libopus`. Audio is **off by default
  and opt-in per camera** — recording audio is legally more restricted than video in many
  places, and an outdoor camera hears passers-by who have not consented. If ffmpeg has
  neither encoder the plugin says so once and streams video only, rather than producing a
  stream HomeKit cannot play.
- Two-way talkback on cameras with a speaker: pressing the microphone button in the Home
  app's live view now plays your voice through the camera. It is **off by default and
  opt-in per camera**, offered in the settings UI only for hardware that reports a
  speaker, and **enabling it needs a restart** — the same one Homebridge already prompts
  for when settings are saved. Talkback is independent of the audio setting: turning it on
  does not start sending the camera's own microphone to HomeKit, and turning audio on does
  not enable talkback. Nothing is sent to the camera until you actually speak.
- Every camera now appears in the Home app as a camera: live view and snapshots are wired
  to HomeKit, bridged like every other accessory so a child bridge still holds the whole
  console under one pairing. The doorbell keeps the single Doorbell service the event
  pipeline drives — attaching live view does not add a second one.
- The settings UI now offers both new per-camera controls, so neither needs `config.json` to
  be edited by hand: a live-view quality selector labelled with the real substream
  resolutions (auto, 2688×1512, 1280×720, 640×360) and an audio toggle, offered only for a
  camera that reports a microphone. The audio toggle says so in its own label: **turning
  audio on takes effect after a restart**, the one Homebridge already prompts for when
  settings are saved. HomeKit is told which audio codecs a camera offers when that camera is
  published, and HAP provides no way to change that afterwards. Turning audio back off
  applies to the next live view immediately.
- New settings: `maxStreams` caps concurrent live views for the whole host (default six on
  hardware encoding, two on software), `ffmpegPath` points at a specific ffmpeg binary, and
  each camera takes `quality` (`auto`, `high`, `medium`, `low`; `auto` by default) and
  `audio` (off by default).
- The settings UI now also offers the two host-wide settings — the maximum number of
  concurrent live views and the ffmpeg path — so nothing this plugin supports needs
  `config.json` to be edited by hand. Clearing either field hands the decision back to the
  plugin rather than storing a blank.
- The README documents how to get hardware transcoding working: passing `/dev/dri` into the
  container, the render-group permission, which VA-API driver package carries the H.264
  encode entrypoint, and the measured cost of not having it (20 s of 2688×1512 costs 1.79 s
  of CPU via VAAPI against 49.1 s via libx264, about 27×).
- A camera configured for audio on an ffmpeg that can encode neither codec HomeKit accepts
  now says so in the log at startup, naming the binary, instead of streaming silently
  without audio.
- ffmpeg is probed once at startup rather than per camera. If no usable ffmpeg is found the
  plugin says so and carries on: sensors, the LED switch and the doorbell all keep working
  without live view instead of the whole platform failing to load.
- Shutting Homebridge down stops every running transcode. A stranded ffmpeg would otherwise
  hold a 4 MP HEVC decode open for as long as the host stayed up.
- ffmpeg processes for live view are now supervised: started, tracked, and killed on
  teardown so a dropped viewer can never leave a transcode running indefinitely. ffmpeg's
  own failure output is redacted before it is ever logged, since the command line it echoes
  on error contains the RTSPS stream's auth token.
- New per-camera setting: `packageCamera`, off by default. The settings UI offers it only
  for a camera the console reports a package lens on, and its label states plainly that the
  console serves that lens at 2 fps — enabling it adds a second HomeKit accessory for one
  physical device, so nobody should be surprised by either consequence after the fact.
- HomeKit Secure Video recording, off by default per camera. A camera with recording
  enabled runs one continuous ffmpeg — RTSPS in, fragmented MP4 out — feeding a 16-fragment
  in-memory prebuffer, so a clip starts *before* the motion that triggered it rather than
  after. Measured on the real console at 7–9% of one core per camera (VAAPI H.264 plus
  ffmpeg's native AAC encoder) on the 1280×720 medium substream that recording uses —
  about half a core across five cameras.
- A clip opens with only as much pre-roll as HomeKit negotiated. The prebuffer *holds*
  16 fragments as headroom, because a fragment runs long when a keyframe arrives late,
  but sending all of them meant handing over ~64 seconds of video at the head of a clip
  whose advertised `prebufferLength` promised 4. Verified on real hardware: the
  controller took the oversized pre-roll and closed the stream in the same second,
  before a single live fragment. With the negotiated amount it records normally.
- Recording advertises exactly one resolution, 1280×720, and both the advertisement and
  the encoder's fallback read the same constant. They had drifted: the advertised ladder
  was trimmed to 720p while the encoder still fell back to the 2688×1512 high substream
  whenever HomeKit had not sent a configuration before the encoder started, so a camera
  recorded four times the pixels it had promised. There is no scale filter in the
  recording path, so an advertised size is only honest if a substream serves it exactly.
- Motion is logged when it fires, naming the camera. It is what triggers every recording
  and it previously reached HomeKit in silence, so a walk past a camera that produced no
  clip left nothing in the log to say whether motion had fired or HomeKit had ignored it.
  The clear, and every non-motion sensor, stay on the debug channel.
- Recording never consumes a live-view stream slot. The `maxStreams` cap exists to protect
  interactive viewing, and a recording process is not an interactive viewer — but the two
  do share the GPU.
- Recording uses H.264 with AAC-LC. HomeKit Secure Video does not permit Opus, which live
  view prefers on this host, so the two pipelines deliberately differ.
- A doorbell press is advertised as a recording trigger alongside motion. **Apple's
  HomeHubs are not currently known to act on it:** hap-nodejs documents that HomeHubs never
  enable Doorbell triggers as of iOS 15-16 and believes the gap is on Apple's side. The
  advertisement is correct and costs nothing, so it will work if and when Apple enables it —
  but today, motion is what starts a clip.
- The settings UI is rebuilt on Homebridge's own injected Bootstrap 5 theme, replacing the
  hand-rolled CSS. It now has four tabs — Connection, Defaults, Devices, Help — with a
  searchable device list beside a detail pane, real toggle switches instead of 13 px
  checkboxes, and settings grouped rather than laid out as one flat grid. Because global
  and per-device settings now live in different places, it is never ambiguous which one is
  being edited. Dark mode comes from Homebridge's theme rather than hardcoded colours.
- Every per-device setting shows whether it is inherited or overridden, and an overridden
  one can be reset to the inherited value.
- Saves are debounced by one second, so flipping several toggles in a row writes
  `config.json` once instead of once per click. Settings that genuinely require a restart
  say so explicitly, rather than every change surfacing Homebridge's restart banner.
- The Defaults tab now carries the per-camera defaults every device inherits — whether new
  devices are exposed, the live view quality and whether recording is on — alongside the
  host-wide settings. The default/overridden badge on each device now points at values the
  UI itself can change, rather than ones only a hand-edited `config.json` could reach.
- The Help tab documents what each setting does, which ones need a restart, how hardware
  transcoding is chosen and what to check when it falls back to software, and that
  recording does not use a live-view slot but does share the GPU with one.
- A new iCloud tier setting (50 GB / 200 GB / 2 TB+, defaulting to 200 GB) drives an
  advisory warning when more cameras have recording enabled than the tier allows — five on
  200 GB, one on 50 GB. It names the tier and both counts, and never blocks the setting:
  the plugin cannot see your subscription, and refusing a setting on a guess would be worse
  than a warning you can ignore.

### Fixed
- The video size and frame rate a controller negotiates are now validated before they
  reach ffmpeg. HAP does not check a controller's selection against the resolutions the
  accessory advertised, so a malformed one asking for 0 fps produced `-r 0`, which ffmpeg
  refuses outright, and an absurd size produced a scale filter that allocated before it
  failed. Both are now clamped into the advertised range rather than rejected, so the
  viewer gets a slightly different picture instead of no picture.
- An ffmpeg process whose kill signal was not delivered is no longer dropped. It used to
  be removed from the session map regardless, leaving nobody able to retry: the orphan
  kept running, held a decode open, and kept its slot in the host-wide stream cap for the
  rest of the uptime, so live views were eventually refused for corpses. A process that
  survives its kill now stays tracked until it genuinely exits.
- The package camera would not stream at all: HomeKit showed "No Response" for every live
  view, with nothing logged anywhere to explain it. It had been advertising a single
  1600×1200 at 15 fps, which HomeKit rejects on two counts — every advertised stream must
  offer at least 24 fps, and 1600×1200 is not one of the 4:3 sizes it accepts. Nothing in
  the stack validates this, so the refusal was silent: HomeKit simply never asked for
  video, and no request ever reached the plugin. It now advertises a range of accepted 4:3
  sizes at 30 fps, and scales the picture to whichever one HomeKit picks.
- A package camera already in HomeKit is no longer unregistered when the plugin starts
  without a usable ffmpeg. It used to be removed immediately — not after the usual
  confirmation window — so a single restart with ffmpeg temporarily missing permanently
  lost the accessory's room, scenes and automations. It is now kept without live view,
  exactly as the main cameras already were. Switching the setting off, or the lens
  genuinely disappearing, still removes it at once.
- The package camera reports its manufacturer, model and serial number to HomeKit
  instead of showing the placeholder values on its tile. Its serial is distinct from the
  main camera's, since the two are separate accessories for one physical device.
- Live view SSRCs are now positive signed 32-bit values. The previous range reached
  0x100000000, which HomeKit and ffmpeg both reject, so a fraction of streams simply never
  loaded — intermittently, and with nothing in the log to explain it.
- Every hardware encoder is now trial-encoded before the plugin commits to it, and a
  candidate that fails falls through to the next one rather than to software. Being listed
  by `ffmpeg -encoders` only means the build was compiled with it, not that the container
  can open `/dev/dri`. On the reference console `/usr/bin/ffmpeg` lists both QSV and VAAPI,
  QSV cannot create its device, and VAAPI works — so the plugin now runs VAAPI there, where
  trusting the listing would have failed every live view and demoting on the first failure
  would have put a perfectly good GPU on software encoding at roughly 27× the CPU.
- A live view requested while Homebridge was shutting down can no longer start an ffmpeg
  after the shutdown handler has already run. Such a process was in no map and nothing would
  ever have killed it.
- A shutdown now stops every remaining live view, the event bus and the failsafe timers even
  if stopping one camera throws.
- An ffmpeg that dies between being spawned and being tracked is reported to HomeKit as a
  failed start instead of being logged as "Live view started".
- A live view whose local RTP port cannot be reserved now fails instead of leaving HomeKit
  waiting on a request that never gets an answer.
- Concurrent live views of the same camera and quality now share a single request to the
  console instead of each creating their own RTSPS stream.
- Discovery no longer restarts the WebSocket subscriptions when Homebridge shuts down while
  accessories are being reconciled.

- Service removal is floored on an understood device payload. The client returns the raw
  payload when schema validation fails, so a single firmware field rename could otherwise
  have stripped every smart-detect sensor, the doorbell and the LED switch from every
  camera. A payload that cannot be understood now removes nothing.
- Services created by other modules are left alone during reconciliation instead of being
  torn down as unrecognised.
- `ConfiguredName` is written once at service creation, so a rename in the Home app
  survives later discovery cycles.
- Documented iCloud limits for HomeKit Secure Video were wrong. Apple caps by camera
  count, not storage: 50 GB supports one camera, 200 GB supports five, and 2 TB and above
  are unlimited. Footage does not count against the iCloud storage quota. HKSV remains off
  by default because the 50 GB tier allows a single camera.

### Security
- Talkback's per-session SRTP key could previously reach the log: ffmpeg echoes its full
  command line on failure, and it echoes the offending line of an SDP it cannot parse.
  Both paths are now redacted before anything is logged.
- ffmpeg's error output is redacted a whole token at a time, so a stream URL split across
  two reads of the pipe — its `rtsps://` scheme arriving separately from its auth token —
  is still redacted. Redaction had been applied per read, which cannot match a URL that
  spans two of them.
- A failure fetching a stream URL is reported as a fresh error carrying the message only.
  Re-throwing the client's own error handed `util.inspect` a request context, which is the
  path that has leaked the API key out of this codebase before.
- The console's certificate is now pinned instead of TLS verification being disabled.
  On the first connection the plugin reads the certificate, stores it in `config.json`
  as `consoleCert` and logs its SHA-256 fingerprint; every later REST request and both
  WebSocket subscriptions are verified against it. Only the hostname check is skipped
  (the certificate is issued for the console's hostname while the plugin connects by IP)
  — certificate identity is enforced, so another host on the LAN can no longer
  impersonate the console and capture the API key.
- A changed certificate fails closed: the plugin refuses to connect, and the log and the
  settings UI both show the trusted and presented fingerprints plus how to re-trust it
  deliberately. Nothing is ever re-trusted silently.

### Known limitations
- Recording audio follows the plugin's own audio setting, not the Home app's "recording
  audio" toggle. The `RecordingAudioActive` characteristic is never read: hap-nodejs does
  not push its value to a recording delegate, and reading it needs the `CameraController`
  instance the plugin currently discards. Two consequences — hap-nodejs defaults that
  characteristic to off, so a camera with audio enabled records clips *with* sound while
  the Home app reports recording audio as off; and changing it in the Home app does
  nothing. Change it in the plugin settings instead.
- A doorbell press does not start a recording in practice, despite being advertised as a
  trigger. See above: hap-nodejs documents this as an Apple-side gap.
- The prebuffer runs a continuous ffmpeg per recording camera because the Integration API
  exposes no push channel for video. Plugins built on UniFi's private livestream WebSocket
  avoid that cost, but that channel requires a username/password UniFi OS login, which this
  plugin deliberately does not implement — it is API-key only. The continuous-ffmpeg model
  is a direct and accepted consequence of that choice.

## [0.1.0] - 2026-07-31

Foundation release. Discovers devices and validates connectivity; accessory services
arrive in a later release.

### Added
- Self-contained UniFi Protect Integration API client, authenticated by API key only —
  no UniFi username or password is ever requested or stored.
- Zod schemas generated from the vendored UniFi Protect 7.1.87 OpenAPI 3.1 specification.
- Real-time device and event WebSocket subscriptions with exponential-backoff reconnect
  and a full REST resync after every reconnect. No polling.
- Homebridge v2 dynamic platform with device discovery and accessory cache reconciliation.
  All accessories are bridged, so a child bridge holds every device under one pairing.
- Custom configuration UI with live device discovery, connection testing, and per-device
  settings. No manual `config.json` editing is required.
- Request throttling with rate-limit backoff, honouring `Retry-After`.
- `npm run live-check`, a manual smoke test against real hardware.

### Known limitations
- No recording-mode switch — `recordingSettings` is absent from the Integration API.
- No privacy mode or privacy zone control.
- No event thumbnail download.
