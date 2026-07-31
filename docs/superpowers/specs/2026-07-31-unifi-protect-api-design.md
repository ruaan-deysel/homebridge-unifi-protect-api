# homebridge-unifi-protect-api — Design

**Date:** 2026-07-31
**Status:** Approved

## Problem

The existing UniFi Protect plugins for Homebridge (`hjdhjd/homebridge-unifi-protect`,
`mp-consulting/homebridge-unifi-protect`) authenticate with a UniFi account username and
password against Protect's private API. UniFi OS now ships an official, documented
Integration API authenticated by a scoped API key. This plugin uses that API exclusively:
no account credentials, no private endpoints, no session cookies.

## Constraints

These are requirements, not preferences.

- **API key only.** No username/password path exists anywhere in the plugin.
- **Zod throughout.** Every payload crossing the network boundary is validated.
- **Self-contained Protect client.** The UniFi Protect API client lives inside this
  repository. No external Protect library, no wrapper packages. Runtime dependencies are
  `zod`, `@homebridge/plugin-ui-utils` and `ws` — nothing else.

  **Revised during execution.** This originally said two dependencies and banned `ws` in
  favour of node's global `WebSocket`. That was proven wrong against real hardware: the
  global is the WHATWG browser API, with no `headers` option, so it cannot send the
  `X-API-KEY` header the subscription requires. The alternative was a hand-written RFC 6455
  implementation. User decision: add `ws`.
- **TypeScript only.** No Python components.
- **Configured entirely from the Homebridge UI.** Editing `config.json` by hand is never
  required for any setting.
- **Homebridge v2**, node `^22 || ^24`, matching the other plugins in this account.

## Verified capability baseline

Probed against a live UDM-Pro running Protect **7.1.87** with an API key. Everything below
was confirmed working, not assumed:

| Capability | Endpoint | Result |
| --- | --- | --- |
| Console identity | `GET /v1/meta/info` | `{"applicationVersion":"7.1.87"}` |
| Device collections | `GET /v1/{cameras,lights,sensors,chimes,viewers,liveviews,nvrs}` | 200 |
| Snapshot | `GET /v1/cameras/{id}/snapshot?highQuality=true` | 200, `image/jpeg`, 215 KB |
| Live video | `GET /v1/cameras/{id}/rtsps-stream?qualities=high` | `rtsps://host:7441/…?enableSrtp` (high / low / package) |
| Device push | `wss://…/v1/subscribe/devices` | Connected, live update frames received |
| Event push | `wss://…/v1/subscribe/events` | Connected |
| Camera writes | `PATCH /v1/cameras/{id}` | 200 |
| Security system | `GET /v1/nvrs` → `armMode` | Present |

Base URL: `https://{host}/proxy/protect/integration`. Auth header: `X-API-KEY`.

The published OpenAPI 3.1 specification (`protect_v7.1.87_openapi.json`) covers **70
operations** and **288 schemas**. Note that `GET /proxy/protect/api-docs/integration.json`
on the console returns **401** for API-key auth — it is cookie-authenticated only, so the
spec must be vendored into the repository rather than fetched at build time.

### Capabilities beyond the private-API plugins

Sirens (play/stop/test), speakers, relays with switchable outputs, alarm hubs, fobs, link
stations, arm profiles, and on-demand RTSPS stream creation and deletion (no manual RTSP
toggling in the Protect UI).

### Confirmed parity

Talkback sessions (`POST /v1/cameras/{id}/talkback-session` returns `talkbackStreamUrl`
plus codec, sampling rate and bits per sample), PTZ preset goto and patrol start/stop,
package camera stream, doorbell LCD messages with image asset upload, chime ring settings,
smart detect zone/line/loiter/audio events, NFC and fingerprint events, snapshots.

### Known gaps versus the private API

Accepted, and to be documented in the README so expectations are set up front:

- No `recordingSettings`, therefore no recording-mode switch.
- No privacy mode or privacy zone control.
- No event thumbnail download.

## Decomposition

Four sub-projects. Each gets its own spec, plan, and shippable release.

| # | Sub-project | Scope |
| --- | --- | --- |
| 1 | **foundation** | Typed API client, generated Zod schemas, WebSocket event bus, Homebridge platform, custom config UI. Accessories registered but service-less. |
| 2 | **cameras** | Camera accessories: live stream, snapshot, doorbell, motion, smart detect, talkback, PTZ. |
| 3 | **hksv** | HomeKit Secure Video: prebuffer, fMP4 pipeline, recording delegate. |
| 4 | **devices** | Lights, sensors, chimes, sirens, speakers, relays, alarm hub, security system. |

This document specifies sub-project 1 in full. Sub-projects 2 through 4 get their own
design documents when they are reached.

---

# Sub-project 1: Foundation

## Layout

```
spec/protect-7.1.87.openapi.json   vendored OpenAPI 3.1, source of truth
scripts/gen-zod.mjs                spec -> src/protect/schemas.ts (dev-only)
scripts/live-check.mjs             manual smoke test against real hardware
src/protect/
  schemas.ts                       GENERATED - zod schemas plus inferred types
  http.ts                          node:https wrapper, injectable HttpRequestFn
  client.ts                        validating REST client over http.ts
  queue.ts                         concurrency-limited request queue with backoff
  events.ts                        WebSocket subscriptions (ws), typed emitter
  errors.ts                        typed error classes
src/platform.ts                    discovery, cache reconciliation, event wiring
src/config.ts                      zod-validated plugin configuration
src/settings.ts                    platform name and plugin identifier constants
src/index.ts                       registration entry point
homebridge-ui/server.js            HomebridgePluginUiServer
homebridge-ui/public/index.html    custom configuration UI
config.schema.json                 declares platform and name only; customUi true
test/fixtures/*.json               redacted captures from real hardware
```

`src/protect/` has no knowledge of HomeKit. It is a standalone typed UniFi Protect client
that could be published independently. `src/platform.ts` is the only module where the
Protect and HomeKit domains meet. This boundary is what makes sub-projects 2 through 4
mostly additive rather than invasive.

## Schema generation

`scripts/gen-zod.mjs` reads the vendored OpenAPI document and emits `src/protect/schemas.ts`.
OpenAPI 3.1 schemas are JSON Schema, so the mapping is mechanical: roughly 150 lines
covering objects, arrays, enums, `$ref` resolution, `oneOf` with discriminators, `allOf`
merging, and nullability.

The generated file is committed. Regenerating is a deliberate act performed when Ubiquiti
publishes a new specification, and the resulting diff is reviewable.

A code generator was chosen over `openapi-zod-client` because that tool emits a Zodios
client wrapper, which the no-wrappers constraint forbids, and because 288 hand-written
schemas is not maintainable by any other means.

## REST client

**Transport is `node:https`, not `fetch`.** Revised during execution and proven against real
hardware: a local console presents a self-signed certificate, `fetch` cannot skip
verification without an undici `dispatcher` (not importable), and it silently ignores an
`agent` option. `https.request` with `rejectUnauthorized: false` works. `src/protect/http.ts`
is a small wrapper exposing an injectable `HttpRequestFn`, which is also what makes the
client testable without a network.

A related trap that caused the original error: `tsconfig.json` had `"DOM"` in `lib`, which
makes `@types/node` suppress its own `fetch`/`Response`/`WebSocket` declarations so
everything resolves to browser types. `DOM` is now removed.

`src/protect/client.ts` responsibilities:

- Base URL construction and the `X-API-KEY` header.
- TLS verification disabled for the configured host only, since a local console presents a
  self-signed certificate. Verification remains on for every other host, and the README
  states this plainly.
- A single request queue with a concurrency cap. Every request passes through it, so a
  burst throttles itself instead of tripping the rate limiter. **This is not speculative:
  the console returned 429 during endpoint probing.**
- Response validation through the generated Zod schemas.
- Typed methods for the endpoints the plugin uses. Endpoints nothing consumes are not
  wrapped.

## Event bus

`src/protect/events.ts` maintains both WebSocket subscriptions, `/v1/subscribe/devices`
and `/v1/subscribe/events`, and exposes a typed emitter keyed by device id.

There is no polling. Reconnection uses exponential backoff, and **every successful
reconnect triggers a full REST resync**, because updates that occurred while the socket was
down are not replayed and are otherwise lost permanently.

## Error handling

| Condition | Behaviour |
| --- | --- |
| 401, revoked or invalid key | `ProtectAuthError`. No retry. Logged once, loudly, including the remedy: regenerate the key in UniFi Site Manager. The WebSocket loop stops, since reconnecting with a dead key only produces noise. |
| 429 | Honour `Retry-After` when present, otherwise exponential backoff. The shared request queue is the primary defence. |
| 404 on a known device | The device was removed. Emit a removal so the platform unregisters the accessory. |
| 5xx, `ECONNREFUSED`, timeout | Backoff and retry. Accessories are marked `NOT_RESPONDING`, never deleted. A rebooting console must not destroy HomeKit rooms, scenes, and automations. |
| Zod parse failure | Log and degrade. Never throw. An unknown enum value or new field from a firmware update warns once per field per session and the device keeps working. This rule is what allows the plugin to survive Protect 7.2 without a release. |
| WebSocket drop | Backoff reconnect, then full REST resync. |

## Configuration model

Written entirely by the custom UI.

```jsonc
{
  "platform": "UniFiProtect",
  "name": "UniFi Protect",
  "host": "192.168.1.1",
  "apiKey": "…",
  "defaults": { "exposeNewDevices": true, "quality": "high", "hksv": false },
  "devices": {
    "aaaaaaaaaaaaaaaaaaaaaaaa": {
      "expose": true,
      "quality": "high",
      "hksv": true,
      "smartDetect": ["person", "package"],
      "talkback": true
    }
  }
}
```

Devices are keyed by **Protect device id, never by name**. Renaming a camera in the Protect
app therefore preserves every per-device setting. Name-keyed configuration silently discards
those settings on rename.

Only values differing from `defaults` are persisted. A device whose settings were never
touched contributes nothing to `config.json`, which keeps the file small and makes changing
a default actually affect every untouched device.

`hksv` defaults to `false` everywhere, including in `defaults`. The reason is **Apple's
iCloud limits, not local resource cost**: the 200 GB plan supports exactly one HKSV camera,
and only the 2 TB plan supports an unlimited number. Defaulting to on would cause HomeKit to
silently refuse to record every camera after the first for anyone below the 2 TB tier, which
presents as a plugin bug. The local cost is secondary and modest, since prebuffering is a
stream copy rather than a transcode.

HKSV is fully implemented in sub-project 3 regardless; this governs only the default value.

## Device lifecycle

| Event | Behaviour |
| --- | --- |
| New device appears in Protect | Governed by `defaults.exposeNewDevices`. When `true`, the default, a newly adopted camera appears in HomeKit without further action. When `false`, it is listed in the UI awaiting opt-in. |
| Device renamed in Protect | Accessory display name follows. Configuration is untouched because it is id-keyed. HomeKit room assignment, scenes, and automations survive. |
| Device removed from Protect | Accessory unregistered, but **only when the console is confirmed reachable**. A device missing while the console is erroring or unreachable is treated as unknown, not gone. |
| `expose` set to `false` | Accessory unregistered, configuration entry retained, so re-enabling restores the previous settings exactly. |
| Configuration entry for an unknown id | Retained, not pruned. It represents a device that is offline or temporarily unadopted. |
| Capability flags change | On each boot the platform diffs live capability flags against the built accessory and adds or removes services. A firmware update that adds package detection surfaces the new sensor automatically. |

## Custom configuration UI

`homebridge-ui/server.js` extends `HomebridgePluginUiServer` and exposes exactly three
request handlers:

| Request | Behaviour |
| --- | --- |
| `/test-connection` | Takes `{host, apiKey}`, calls `GET /v1/meta/info`, returns the Protect version and NVR name, or a specific failure reason: invalid key, host unreachable, wrong port, or not a Protect console. |
| `/discover` | Fetches all device collections and returns a slim rendering view: id, name, type, and capability flags such as `hasSpeaker`, `hasPackageCamera`, `smartDetectTypes`, and `hasLedStatus`. |
| `/save` | Handled client-side. The UI merges per-device settings into the configuration object and calls `homebridge.updatePluginConfig()`. |

The API key is never logged, and is validated before being persisted.

Capability flags drive form rendering. A camera without a speaker does not render a talkback
toggle, so the UI cannot offer a setting the hardware is unable to honour.

`config.schema.json` declares only `platform` and `name`, with `customUi` set to `true`.
This is what makes "nothing in JSON files" accurate rather than aspirational.

## Homebridge integration decisions

- Homebridge v2 only, node `^22 || ^24`.
- **Every accessory is bridged**, cameras included. Registration uses
  `api.registerPlatformAccessories`, never `api.publishExternalAccessories`. Bridged cameras
  have been fully supported by HAP-NodeJS since v0.5.1, and Homebridge PR #2480 wired
  `CameraController` into the standard dynamic platform registration path. A user who
  configures a child bridge named "UniFi Protect" therefore gets every camera, sensor,
  chime, and the security system under that single bridge: one QR code, one entry in
  Home.app.
- **One HomeKit accessory per Protect device.** A camera's motion sensor, doorbell, and
  smart-detect sensors are additional *services* on the camera accessory, distinguished by
  subtype, not separate accessories. This keeps a typical installation near ten accessories
  and well clear of the 149-accessory bridge limit, so bridging everything stays viable
  even for large camera counts.
- The README recommends running the plugin in a child bridge, for process isolation rather
  than for accessory-limit reasons.
- The API key is stored in `config.json`, consistent with every other Homebridge credential.

## Testing

Matching the conventions already established in `homebridge-actronair-neo` and
`homebridge-philips-airctrl`: vitest, with `test/fixtures/*.json` captured from real
hardware and redacted of device ids, MAC addresses, and stream tokens.

Unit tests perform no network access. Client tests use a stubbed `fetch`; event tests use a
fake socket. Coverage targets:

- Generated schemas round-tripping real captured fixtures.
- Retry, backoff, and 429 queue behaviour.
- Reconnect followed by full resync.
- Accessory cache reconciliation across add, remove, and rename.
- Configuration validation, including rejection of malformed and partial input.
- UI server request handlers.

`scripts/live-check.mjs` is a manual smoke test that reads `.env`, exercises every endpoint
the plugin depends on against real hardware, and asserts the responses still match the
vendored schemas. It is deliberately excluded from `npm test`. Its purpose is to identify
what broke after a Protect firmware update, and it is a repeatable form of the probing that
produced the capability baseline above.

## Definition of done for the foundation

1. `npm run build`, `npm run lint`, and `npm test` all pass.
2. The plugin loads in Homebridge, validates the API key, and logs the discovered device
   inventory. Accessories **are** registered, one per Protect device, but carry **no
   services** — they appear in Home.app as empty accessories until sub-project 2 adds
   camera and sensor services.
3. Both WebSockets connect, and received frames are logged in debug mode.
4. Killing and restoring console connectivity produces a clean reconnect followed by a
   resync, with no crash and no duplicate accessories.
5. The custom UI tests a connection, discovers real devices, and persists per-device
   settings without any hand editing of `config.json`.
6. `scripts/live-check.mjs` passes against the live UDM-Pro.

---

# Carried forward into sub-project 2

Written at the close of sub-project 1, from the execution ledger. These are known
ceilings and deferred items, not bugs — each was reviewed and deliberately left.

## Must be handled by the camera sub-project

- **Capability-flag diffing is unimplemented.** The design specifies that the platform
  diffs live capability flags per boot and adds/removes services. There were no services
  to diff, so it was deferred. `accessory.context.device` is refreshed on every reconcile
  and merged on every delta — that is the hook.
- **`context.device` is stale between Homebridge start and the first successful
  discovery**, because `configureAccessory` restores whatever was serialized last run.
  Services must not treat it as current until discovery has run once.
- **The UI's HKSV and talkback toggles are rendered disabled**, behind a `comingLater`
  flag. When the services land, drop the flag or the settings stay unreachable. A config
  hand-edited to `hksv: true` currently shows checked-but-disabled and cannot be cleared.
- **`ffmpeg-for-homebridge` must be added as an `optionalDependency`** with a
  system-ffmpeg fallback. HomeKit camera audio requires AAC-ELD, and most system ffmpeg
  builds — including Homebrew's — ship without `libfdk_aac`. Verified on this machine.
- **Event frames arrive unvalidated as `unknown`.** The platform validates by `modelKey`
  using a `Map` (an object literal lets `modelKey: "constructor"` return an inherited
  function and throw). Frames are deltas, so schemas are `.partial()` — the full schema
  rejects every real frame.
- **The devices-channel frame shape is inferred from tests, not observed live.** Confirm
  it against a real rename before building on it.

## Known ceilings, safe to carry

- **No polling anywhere.** The accessory-removal confirmation window is a floor, not a
  bound: it is only evaluated when a discovery runs, so on a quiet console a genuinely
  deleted device waits for the next `resyncRequired` or a restart. It fails toward keeping
  accessories, which is the safe direction. A polling pass would close it.
- **A socket that pongs but silently delivers nothing stays undetectable.** The watchdog
  proves liveness, not delivery. The API offers no second signal.
- **`Promise.all` over the five inventory endpoints is all-or-nothing.** One endpoint
  404ing means no device is ever registered. Today's hardware passes 11/11.
- **Shutdown ignores in-flight REST results rather than aborting them.** A real fix needs
  an `AbortSignal` threaded through `ProtectClient`.
- **`start()` is no longer a force-reset for a wedged dial** — `stop()` then `start()` is
  the lever. The handshake is bounded, so this is inconvenient rather than load-bearing.
- **Ping interval (30s) and handshake timeout (15s configured, ~30s effective — `ws` arms
  it twice over TLS) are module-level constants**, not options. Promote them if anyone
  reports flapping.
- **`test/http.test.ts` shells out to `openssl`.** Fine on `ubuntu-latest`; fragile on a
  minimal container.
- **`API_BASE_PATH` is still hardcoded in `homebridge-ui/server.js` and
  `scripts/live-check.mjs`** — neither can import from `src/`.

## Lessons that changed the code

- `fetch` cannot skip verification of a self-signed certificate in node and silently
  ignores an `agent` option. Transport is `node:https`.
- Node's global `WebSocket` is the WHATWG browser API: no `headers` option, so it cannot
  send `X-API-KEY`. Hence `ws`.
- `"DOM"` in `tsconfig` `lib` makes `@types/node` suppress its own declarations, so
  everything resolves to browser types. That is what made the two errors above typecheck.
- `ws` auto-**pongs** but never initiates a ping. A liveness watchdog is mandatory.
- Ubiquiti's own spec marks `ringSettings.ringtoneId` and `nvrArmMode.armProfileId`
  required; the console never sends them. See `OPTIONAL_OVERRIDES` in the generator.
