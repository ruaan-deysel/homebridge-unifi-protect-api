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
camera, because of an iCloud plan constraint that has nothing to do with this plugin.
Apple's camera limits are: the 50 GB plan supports **one** camera, the 200 GB plan supports
up to **five**, and the 2 TB plan and above support an **unlimited** number. HKSV footage
does *not* count against your iCloud storage quota — the limit is on camera count, not
gigabytes. Enabling HKSV for more cameras than your plan supports will cause Apple to
silently stop recording some of them, so per-camera opt-in is deliberate.

## Bridging

All accessories are **bridged**. This plugin runs as a child bridge named for it, and every
discovered device is published under that one HomeKit pairing rather than as separate
standalone accessories.

## Security note: certificate pinning

Local UniFi consoles present a self-signed certificate for an IP address (or a
non-publicly-resolvable hostname), which no public certificate authority can validate. This
plugin therefore **pins your console's own certificate**: on the first connection it reads
the certificate, stores it in `config.json` as `consoleCert`, and logs its SHA-256
fingerprint so you can compare it with the one your console shows. Every later connection —
REST and both WebSocket subscriptions — is verified against that certificate and nothing
else. Verification is never disabled, and never process-wide.

Only the hostname check is skipped, because the certificate is issued for the console's own
hostname while you connect to it by IP. Certificate identity is still enforced, which is
what stops anything else on your network from impersonating the console and collecting your
API key.

If the certificate ever changes, the plugin **refuses to connect** and logs both
fingerprints rather than trusting the new one. That is expected after the console is
reinstalled, reset, or has its certificate regenerated — in which case re-trust it
deliberately with **Trust this certificate** in the plugin settings, or by deleting the
`consoleCert` line from the `UniFiProtect` block in `config.json` and restarting Homebridge.
If you cannot explain the change, treat it as an interception attempt and do not re-trust
it. `consoleCert` is your own hardware's identity: it is written by the plugin, and should
not be copied between installs or committed anywhere.

## Manual hardware check

`npm run live-check` runs a smoke test against a real console (not part of `npm test`).
Copy `.env.example` to `.env`, fill in `PROTECT_HOST` and `PROTECT_API_KEY`, then run it.
Useful after a Protect firmware update to see what changed before your users do.
