# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
  larger uses high. Per-camera quality override allows manual selection or disables
  automatic scaling.
- Live view transcoding now probes ffmpeg at startup and prefers Intel Quick Sync (QSV) or
  VAAPI hardware encoding over the bundled software encoder, since every Protect stream is
  HEVC and HomeKit only accepts H.264. Hardware encoding cuts CPU cost roughly 27× on
  supported hosts; the chosen ffmpeg path and encoder are logged so a silent fallback to
  software is visible rather than just running expensive.

### Fixed
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
