# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
