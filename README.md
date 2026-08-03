# homebridge-unifi-protect-api

A [Homebridge](https://homebridge.io) plugin for [UniFi Protect](https://ui.com/camera-security),
built on Ubiquiti's **official UniFi Protect Integration API**. Authentication is a single
API key — this plugin never asks for, requests, or stores a UniFi username or password.

## Status

Unreleased, on top of the 0.1.0 foundation release. It discovers your Protect devices,
validates connectivity over REST and both WebSocket channels, reconciles the Homebridge
accessory cache, and exposes:

- **Live view and snapshots** for every camera. Snapshots come straight from the console as
  JPEG; live view transcodes Protect's HEVC to the H.264 HomeKit requires, with optional
  per-camera audio (off by default) and, on cameras with a speaker, optional two-way
  talkback (also off by default).
- **Sensors** driven by the live event stream: motion, smart detection (person, vehicle,
  animal, package), smoke and carbon monoxide, and a Doorbell service on cameras with a
  speaker.
- **A status-LED switch** on cameras that have one.

Talkback is a separate setting from audio: turning it on does not start sending the
camera's own microphone to HomeKit, and it has no effect on the audio setting either way.
Like the audio setting, **enabling talkback takes effect after a restart** — the same one
Homebridge already prompts for when settings are saved.

Still to come: light accessories. See `CHANGELOG.md`.

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

## Hardware transcoding

Every Protect camera streams HEVC; HomeKit accepts only H.264. Every live view is therefore
a transcode, and on this hardware the difference between doing it on the GPU and doing it on
the CPU is not marginal. Measured on the reference host (i7-8700K, UHD 630) on 2026-08-01,
**20 seconds of 2688×1512 costs 1.79 s of CPU via VAAPI and 49.1 s via libx264 — about 27×**.
That is why the plugin defaults to six concurrent live views on hardware and only two on
software: three software streams would saturate a 12-thread host on their own.

At startup the plugin probes ffmpeg, prefers Intel Quick Sync (QSV) then VAAPI, and
**trial-encodes each one** rather than trusting `-encoders` to list it. A candidate that
cannot initialise is skipped and the next is tried; software is the last resort, not the
second. The log line says which one it ended up on:

```
Using ffmpeg at /usr/bin/ffmpeg with hardware encoding (h264_vaapi).
```

Seeing `h264_vaapi` rather than `h264_qsv` on an Intel host is normal and not a fault: on
the reference console (UHD 630, i915) `/usr/bin/ffmpeg` lists both, QSV fails with
`Device creation failed: -1313558101`, and VAAPI encodes cleanly. Run Homebridge with
`DEBUG` logging to see which candidates were rejected and why.

A `warn` naming `libx264` instead means hardware acceleration is not reaching the process.
The usual causes, in order:

1. **The render device is not in the container.** Homebridge in Docker sees no GPU unless you
   pass one in. Add `--device=/dev/dri` to `docker run`, or under Compose:

   ```yaml
   services:
     homebridge:
       devices:
         - /dev/dri:/dev/dri
   ```

   Restart the container, then check `ls -l /dev/dri` inside it shows a `renderD128`.

2. **The user cannot open it.** `/dev/dri/renderD128` is normally owned by the `render` (or
   on older systems `video`) group. Either run the container with `group_add:` for that
   group's numeric GID from the host, or confirm the Homebridge user is in it.

3. **The driver is not installed.** On Debian/Ubuntu hosts and images:

   ```sh
   sudo apt install intel-media-va-driver-non-free vainfo   # Gen 8+ Intel, includes UHD 630
   vainfo                                                    # must list VAEntrypointEncSlice for H264
   ```

   `intel-media-va-driver-non-free` is the one that carries the H.264 encode entrypoint; the
   plain `intel-media-va-driver` package does not. On AMD use `mesa-va-drivers`.

4. **The ffmpeg being used is the wrong one.** The Homebridge image ships more than one
   build, and they do not have the same capabilities: `/usr/bin/ffmpeg` has QSV and VAAPI but
   no `libfdk_aac`, while the bundled static build is the other way round. The plugin prefers
   a hardware-capable binary automatically, but you can pin one with the **ffmpeg path**
   setting in the plugin's settings screen.

Software encoding is a supported configuration, not a broken one — it is simply expensive.
If you are staying on it, lower **Maximum concurrent live views** in the plugin settings and
pin the per-camera quality to `medium` or `low` rather than `auto`.

## Known limitations

Compared with plugins that use UniFi's private, undocumented API, the official Integration
API currently has these gaps:

- No recording-mode switch — `recordingSettings` is absent from the Integration API.
- No privacy mode or privacy zone control.
- No event thumbnail download.

## HomeKit Secure Video

HomeKit Secure Video (HKSV) is **off by default and enabled per camera**, because of an
iCloud plan constraint that has nothing to do with this plugin. Apple's camera limits are:
the 50 GB plan supports **one** camera, the 200 GB plan supports up to **five**, and the
2 TB plan and above support an **unlimited** number. HKSV footage does *not* count against
your iCloud storage quota — the limit is on camera count, not gigabytes. Enabling HKSV for
more cameras than your plan supports will cause Apple to silently stop recording some of
them, so per-camera opt-in is deliberate. Set your plan on the **Defaults** tab and the
settings UI warns before you exceed it.

The package lens is a separate HomeKit accessory but **does not record** — it is offered for
live view and snapshots only — so enabling it does not use one of your plan's cameras. A
doorbell with a package lens still counts as one.

### What it costs

Each camera with recording enabled runs one continuous ffmpeg, whether or not anything ever
moves — that is what fills the prebuffer so a clip starts *before* the motion rather than
after it. Measured on this hardware with VAAPI H.264 and ffmpeg's native AAC encoder, that
is **7–9% of one core per camera** on the medium substream, which is what recording uses —
about half a core across five. (The 15% figure quoted during design was measured against
the 2688×1512 high substream; recording advertises and delivers 1280×720, so it costs
less.)

Two caveats on that. **Pinning a camera's quality to `high` overrides this** — an explicit
preference wins, so that camera records 2688×1512 and costs roughly the 15% figure instead.
And a **quality change does not reach a camera that is already recording**: the setting is
read when the encoder starts, and nothing restarts a healthy one, so it applies from the
next Homebridge restart.

The continuous encode is a consequence of this plugin being API-key only. Plugins that
prebuffer from UniFi's private livestream WebSocket avoid it, but that channel requires a
username/password UniFi OS login, which this plugin deliberately does not implement.

Recording does **not** consume a live-view stream slot — the `maxStreams` cap protects
interactive viewing, and a recording process is not an interactive viewer — but the two do
share the GPU.

### Two limitations worth knowing before you test

**A doorbell press will not start a recording; motion will.** The press is correctly
advertised as a trigger, but hap-nodejs documents that HomeKit HomeHubs never enable
Doorbell triggers as of iOS 15-16, and considers it unsupported on Apple's side. The
advertisement costs nothing and will work if Apple enables it. Until then, if you press the
button and no clip appears, that is expected rather than a fault.

**Recording audio follows the plugin setting, not the Home app toggle.** The
`RecordingAudioActive` characteristic is never read — hap-nodejs does not push it to a
recording delegate. hap-nodejs defaults it to off, so a camera with audio enabled records
clips *with* sound while the Home app reports recording audio as off, and changing it there
does nothing. Change it in the plugin settings.

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
