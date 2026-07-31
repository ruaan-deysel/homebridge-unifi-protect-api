# homebridge-unifi-protect-api

A [Homebridge](https://homebridge.io) plugin for [UniFi Protect](https://ui.com/camera-security),
built on Ubiquiti's **official UniFi Protect Integration API**. Authentication is a single
API key — this plugin never asks for, requests, or stores a UniFi username or password.

## Status

This is the **0.1.0 foundation release**. It discovers your Protect devices, validates
connectivity over REST and both WebSocket channels, and reconciles the Homebridge accessory
cache. **It does not yet expose any HomeKit accessory services** (no camera streaming, no
sensors, no lights) — that arrives in a later release. See `CHANGELOG.md`.

> **What you will see in Home.app:** one accessory per Protect device, each of them
> **empty** — no controls, no streams, no sensor readings. That is expected for 0.1.0,
> not a misconfiguration. The accessories exist so that later releases can attach services
> to them without you having to re-pair or re-assign rooms. If you would rather not have
> empty tiles in Home.app yet, untick the devices in the plugin's settings screen.

## Requirements

- UniFi Protect **7.1.87** — the only firmware this release has been tested against, on a
  UniFi console with the Integration API enabled. Ubiquiti introduced the Integration API in
  Protect 6.1, so earlier 6.x/7.x builds may well work, but nothing below 7.1.87 has been
  verified.
- Homebridge v2
- Node.js 22 or 24

## Setup

1. In UniFi Site Manager, go to **Integrations** and create an API key for your console.
2. In the Homebridge UI, add this plugin and open its settings.
3. Paste the console address (IP or hostname) and the API key.
4. Click **Test Connection** to confirm the plugin can reach your console and enumerate
   devices before saving.

## Known limitations

Compared with plugins that use UniFi's private, undocumented API, the official Integration
API currently has these gaps:

- No recording-mode switch — `recordingSettings` is absent from the Integration API.
- No privacy mode or privacy zone control.
- No event thumbnail download.

## HomeKit Secure Video

HomeKit Secure Video (HKSV) support is planned for a later sub-project and is **not
implemented in this release**. When it ships, it will be off by default and enabled per
camera, because of an iCloud storage constraint that has nothing to do with this plugin:
Apple's 200 GB iCloud plan supports exactly **one** HKSV camera, and only the 2 TB plan (or
higher) supports an unlimited number of HKSV cameras. Enabling HKSV for more cameras than
your iCloud plan supports will cause Apple to silently stop recording some of them, so
per-camera opt-in is deliberate.

## Bridging

All accessories are **bridged**. This plugin runs as a child bridge named for it, and every
discovered device is published under that one HomeKit pairing rather than as separate
standalone accessories.

## Security note: TLS verification

Local UniFi consoles present a self-signed certificate for an IP address (or a
non-publicly-resolvable hostname), which no public certificate authority can validate. To
connect at all, this plugin **disables TLS certificate verification, but only for the
console address you configure** — it does not weaken TLS verification for any other
connection. The same applies to both WebSocket subscriptions used for real-time device and
event updates. Only point this plugin at a UniFi console you trust and control.

## Manual hardware check

`npm run live-check` runs a smoke test against a real console (not part of `npm test`).
Copy `.env.example` to `.env`, fill in `PROTECT_HOST` and `PROTECT_API_KEY`, then run it.
Useful after a Protect firmware update to see what changed before your users do.
