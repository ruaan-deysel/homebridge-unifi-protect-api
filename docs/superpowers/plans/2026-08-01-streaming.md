# Live streaming and snapshots — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every UniFi Protect camera a working live view and snapshot in HomeKit, using hardware transcoding where available and degrading safely to software where not.

**Architecture:** Four new modules with narrow interfaces — an ffmpeg capability probe and process supervisor, an RTSPS URL cache, a pure substream selector, and a HAP `CameraStreamingDelegate` that composes them. `src/platform.ts` attaches a `CameraController` per camera. Every unit is testable with no ffmpeg and no Homebridge.

**Tech Stack:** TypeScript, Zod 4, `node:child_process`, HAP-NodeJS `CameraController`, ffmpeg (VAAPI/QSV where present), Vitest 4.

**Global Constraints:**

- **The RTSPS URL is a credential.** It carries an auth token. It must never reach a log line, an error message, a thrown `Error`, or a crash report — including via `util.inspect`, which is what Homebridge's `log.error(err)` uses. **ffmpeg echoes its full command line on failure by default**, so stderr must be redacted *before* logging, not filtered after.
- **The API key is a credential** under the same rules. `errorMessage()` in `src/protect/errors.ts` is the only sanctioned way to turn an error into a loggable string.
- **All cameras stay under ONE bridge**: `registerPlatformAccessories` only, never `publishExternalAccessories`.
- **Never `Date.now()` for elapsed-time decisions** — this hardware NTP-steps its wall clock after a power cut. `performance.now()` only.
- **Do NOT add streaming subtypes to `OWNED_SUBTYPES`** in `src/accessories/camera.ts`. That allow-list makes unknown services survive the sensor removal loop; adding streaming services would make them eligible for deletion — the exact opposite of what is needed.
- **Do not ask `CameraController` for a Doorbell service.** Sub-project 2a already created a subtyped `ring` Doorbell driven by the event pipeline. Two Doorbell services make the doorbell appear twice in Home.app.
- **Audio is off by default**, opt-in per camera.
- **Concurrency caps differ by encoder path**: hardware 6, software 2.
- Device names are attacker-controlled — never interpolate into markup.
- Zod 4: `.default()` short-circuits and does NOT re-parse.

**User decisions (already made):**

- "go with B" — hardware transcoding, with runtime auto-detection and software fallback so the plugin still works on hosts without QuickSync.
- "go with A" — talkback is **out of scope**, deferred to sub-project 2c. Only the Doorbell has a speaker.
- "go with A" — nearest-substream selection, overridable per camera.
- "go with b" — audio **off by default**, opt-in per camera (Australian surveillance-devices law is stricter for audio than video).
- Architecture, lifecycle and testing sections of the spec approved verbatim.

**Measured on the live host (2026-08-01), and the basis for the concurrency caps:** 20 s of real 2688×1512 HEVC → H.264 costs **1.79 s CPU via VAAPI** versus **49.1 s via libx264** — about 27×.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/protect/ffmpeg.ts` | Probe ffmpeg paths/capabilities; own all subprocess spawning, killing, reaping; redact stderr |
| `src/accessories/quality.ts` | Pure substream selection — requested resolution → quality |
| `src/protect/stream.ts` | RTSPS URL acquisition and caching |
| `src/accessories/streaming.ts` | HAP `CameraStreamingDelegate` — sessions, snapshots, ffmpeg argument construction |
| `src/platform.ts` | Attach `CameraController` per camera accessory |
| `src/config.ts` | Per-camera `quality`, `audio`; global `maxStreams`, `ffmpegPath` |

---

## Task 0: Capture real ffmpeg capability fixtures

**Goal:** Record what `ffmpeg` actually prints for capabilities on a hardware-capable host and a software-only one, so capability parsing is tested against real text rather than invented text.

**Files:**
- Create: `scripts/capture-ffmpeg-caps.mjs`
- Create: `test/fixtures/ffmpeg/hardware.json`, `test/fixtures/ffmpeg/software.json`

**Acceptance Criteria:**
- [ ] script captures `-hwaccels` and `-encoders` output verbatim for a given ffmpeg path
- [ ] `hardware.json` contains real output from a build with `vaapi` and `qsv` (Ubuntu ffmpeg 6.1.1)
- [ ] `software.json` contains real output from a build with neither (the bundled `8.0-homebridge-alpine-x86_64-static`, whose only hwaccel is `amf`)
- [ ] no file path, hostname, or credential appears in either fixture
- [ ] fixtures are committed

**Verify:** `node scripts/capture-ffmpeg-caps.mjs /usr/bin/ffmpeg` prints JSON containing `h264_vaapi`

**Steps:**

- [ ] **Step 1: Write `scripts/capture-ffmpeg-caps.mjs`**

```js
#!/usr/bin/env node
// Captures ffmpeg capability output so parsing is tested against text ffmpeg
// really prints. In sub-project 2a the only bug that survived every review came
// from code and tests sharing an invented payload shape; this is the same trap
// in a new place, and capability parsing decides hardware vs software encoding
// — a wrong answer fails silently and merely runs slow.
import { execFileSync } from 'node:child_process'
import process from 'node:process'

const path = process.argv[2] ?? 'ffmpeg'
const run = args => execFileSync(path, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const out = {
  // The version line names the build, which is how a human tells these fixtures
  // apart. It contains no paths.
  version: run(['-hide_banner', '-version']).split('\n')[0],
  hwaccels: run(['-hide_banner', '-hwaccels']),
  encoders: run(['-hide_banner', '-encoders']),
}
console.log(JSON.stringify(out, null, 2))
```

- [ ] **Step 2: Capture both fixtures from the live container**

Run:
```bash
ssh 192.168.20.21 'docker cp - homebridge:/tmp/ < /dev/null' 2>/dev/null || true
# hardware-capable build
ssh 192.168.20.21 'docker exec homebridge /usr/bin/ffmpeg -hide_banner -hwaccels; echo ---; docker exec homebridge /usr/bin/ffmpeg -hide_banner -encoders' > /tmp/hw.txt
# software-only build
ssh 192.168.20.21 'docker exec homebridge /usr/local/bin/ffmpeg -hide_banner -hwaccels; echo ---; docker exec homebridge /usr/local/bin/ffmpeg -hide_banner -encoders' > /tmp/sw.txt
```

Then assemble each into the JSON shape the script emits (`version`, `hwaccels`, `encoders`) and write to `test/fixtures/ffmpeg/hardware.json` and `test/fixtures/ffmpeg/software.json`.

Expected in `hardware.json`: `hwaccels` contains `vaapi` and `qsv`; `encoders` contains `h264_vaapi` and `h264_qsv`.
Expected in `software.json`: `hwaccels` contains only `amf`; `encoders` contains `libx264` but neither `h264_vaapi` nor `h264_qsv`.

- [ ] **Step 3: Verify no secrets**

Run: `grep -rE "rtsps://|X-API-KEY|192\.168\." test/fixtures/ffmpeg/ ; echo "exit: $?"`
Expected: exit 1, no matches.

- [ ] **Step 4: Commit**

```bash
git add scripts/capture-ffmpeg-caps.mjs test/fixtures/ffmpeg
git commit -m "test: capture real ffmpeg capability fixtures"
```

---

## Task 1: ffmpeg capability probe

**Goal:** Decide, once at startup, which ffmpeg binary and encoder to use — preferring hardware, falling back to software, and logging the choice so a silent fallback is visible.

**Files:**
- Create: `src/protect/ffmpeg.ts`
- Test: `test/ffmpeg.test.ts`

**Acceptance Criteria:**
- [ ] `chooseEncoder` returns `h264_qsv` when both the `qsv` hwaccel and the `h264_qsv` encoder are present
- [ ] returns `h264_vaapi` when vaapi is present and qsv is not
- [ ] returns `libx264` when neither is present
- [ ] parsing is driven by the Task 0 fixtures, not by invented text
- [ ] `probeFfmpeg` tries candidate paths in order and picks the first with hardware support, falling back to the first that runs at all
- [ ] a configured `ffmpegPath` overrides the candidate list
- [ ] the chosen path and encoder are logged at info level

**Verify:** `npx vitest run test/ffmpeg.test.ts` → all passing

**Steps:**

- [ ] **Step 1: Write the failing tests**

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { chooseEncoder, probeFfmpeg } from '../src/protect/ffmpeg.js'

const fixture = (n: string) => JSON.parse(readFileSync(`test/fixtures/ffmpeg/${n}.json`, 'utf8'))

describe('chooseEncoder', () => {
  it('prefers qsv when the real hardware build offers it', () => {
    const { hwaccels, encoders } = fixture('hardware')
    expect(chooseEncoder(hwaccels, encoders)).toEqual({ encoder: 'h264_qsv', hwaccel: 'qsv' })
  })

  it('falls back to libx264 on the real software-only build', () => {
    const { hwaccels, encoders } = fixture('software')
    expect(chooseEncoder(hwaccels, encoders)).toEqual({ encoder: 'libx264' })
  })

  it('uses vaapi when qsv is absent', () => {
    const { encoders } = fixture('hardware')
    expect(chooseEncoder('vaapi\ndrm\n', encoders)).toEqual({ encoder: 'h264_vaapi', hwaccel: 'vaapi' })
  })

  // The encoder list contains `hevc_qsv` and `mjpeg_qsv` too. A substring match
  // on "qsv" would pass while selecting a codec HomeKit cannot decode.
  it('does not mistake hevc_qsv for an H.264 encoder', () => {
    expect(chooseEncoder('qsv\n', ' V..... hevc_qsv HEVC (Intel Quick Sync)\n V....D libx264 libx264 H.264\n'))
      .toEqual({ encoder: 'libx264' })
  })
})

describe('probeFfmpeg', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

  it('picks the hardware-capable path even when a software one comes first', async () => {
    const hw = fixture('hardware')
    const sw = fixture('software')
    const run = vi.fn(async (path: string, args: string[]) => {
      const f = path === '/usr/bin/ffmpeg' ? hw : sw
      return args.includes('-hwaccels') ? f.hwaccels : f.encoders
    })
    const caps = await probeFfmpeg({ log, run, candidates: ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'] })
    expect(caps).toEqual({ path: '/usr/bin/ffmpeg', encoder: 'h264_qsv', hwaccel: 'qsv' })
  })

  it('honours a configured path without probing others', async () => {
    const hw = fixture('hardware')
    const run = vi.fn(async (_p: string, args: string[]) => args.includes('-hwaccels') ? hw.hwaccels : hw.encoders)
    const caps = await probeFfmpeg({ log, run, candidates: ['/a', '/b'], configuredPath: '/custom/ffmpeg' })
    expect(caps.path).toBe('/custom/ffmpeg')
    expect(run).toHaveBeenCalledWith('/custom/ffmpeg', expect.arrayContaining(['-hwaccels']))
    expect(run).not.toHaveBeenCalledWith('/a', expect.anything())
  })

  it('falls back to a runnable software binary when none support hardware', async () => {
    const sw = fixture('software')
    const run = vi.fn(async (path: string, args: string[]) => {
      if (path === '/missing')
        throw new Error('ENOENT')
      return args.includes('-hwaccels') ? sw.hwaccels : sw.encoders
    })
    const caps = await probeFfmpeg({ log, run, candidates: ['/missing', '/usr/local/bin/ffmpeg'] })
    expect(caps).toEqual({ path: '/usr/local/bin/ffmpeg', encoder: 'libx264' })
  })

  it('throws when no candidate runs at all', async () => {
    const run = vi.fn(async () => { throw new Error('ENOENT') })
    await expect(probeFfmpeg({ log, run, candidates: ['/a'] })).rejects.toThrow(/no usable ffmpeg/i)
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/ffmpeg.test.ts`
Expected: FAIL — `src/protect/ffmpeg.ts` does not exist.

- [ ] **Step 3: Implement the probe**

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { errorMessage } from './errors.js'

const execFileAsync = promisify(execFile)

/** Candidate binaries, best-known-hardware first. */
export const FFMPEG_CANDIDATES = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg']

export interface FfmpegCapabilities {
  path: string
  encoder: 'h264_qsv' | 'h264_vaapi' | 'libx264'
  hwaccel?: 'qsv' | 'vaapi'
}

export type RunFfmpeg = (path: string, args: string[]) => Promise<string>

export const runFfmpeg: RunFfmpeg = async (path, args) => {
  const { stdout } = await execFileAsync(path, args, { timeout: 10_000 })
  return stdout
}

/**
 * An encoder line looks like ` V..... h264_qsv  H.264 / AVC ... `. Anchoring on
 * a word boundary matters: the same list contains `hevc_qsv` and `mjpeg_qsv`,
 * and a substring match on "qsv" would select a codec HomeKit cannot decode.
 */
function hasEncoder(encoders: string, name: string): boolean {
  return new RegExp(`^\\s*\\S+\\s+${name}\\b`, 'm').test(encoders)
}

function hasHwaccel(hwaccels: string, name: string): boolean {
  return new RegExp(`^\\s*${name}\\s*$`, 'm').test(hwaccels)
}

export function chooseEncoder(hwaccels: string, encoders: string): Omit<FfmpegCapabilities, 'path'> {
  if (hasHwaccel(hwaccels, 'qsv') && hasEncoder(encoders, 'h264_qsv'))
    return { encoder: 'h264_qsv', hwaccel: 'qsv' }
  if (hasHwaccel(hwaccels, 'vaapi') && hasEncoder(encoders, 'h264_vaapi'))
    return { encoder: 'h264_vaapi', hwaccel: 'vaapi' }
  return { encoder: 'libx264' }
}

interface ProbeOptions {
  log: { info: (m: string) => void, debug: (m: string) => void }
  run?: RunFfmpeg
  candidates?: string[]
  configuredPath?: string
}

export async function probeFfmpeg(options: ProbeOptions): Promise<FfmpegCapabilities> {
  const run = options.run ?? runFfmpeg
  const paths = options.configuredPath ? [options.configuredPath] : (options.candidates ?? FFMPEG_CANDIDATES)

  let fallback: FfmpegCapabilities | undefined
  for (const path of paths) {
    let caps: Omit<FfmpegCapabilities, 'path'>
    try {
      const [hwaccels, encoders] = await Promise.all([
        run(path, ['-hide_banner', '-hwaccels']),
        run(path, ['-hide_banner', '-encoders']),
      ])
      caps = chooseEncoder(hwaccels, encoders)
    }
    catch (error) {
      options.log.debug(`ffmpeg at ${path} is not usable: ${errorMessage(error)}`)
      continue
    }
    if (caps.encoder !== 'libx264') {
      options.log.info(`Using ffmpeg at ${path} with hardware encoding (${caps.encoder}).`)
      return { path, ...caps }
    }
    // Keep looking: a later candidate may have hardware support. `/usr/local/bin`
    // precedes `/usr/bin` on PATH in the Homebridge image, and the binary it
    // shadows is the one WITHOUT Intel support.
    fallback ??= { path, ...caps }
  }

  if (!fallback)
    throw new Error('Found no usable ffmpeg. Set ffmpegPath in the plugin settings.')

  options.log.info(`Using ffmpeg at ${fallback.path} with software encoding (libx264). Live view will be CPU-expensive; see the README on enabling hardware transcoding.`)
  return fallback
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run test/ffmpeg.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Mutation-check**

Break `hasEncoder` to a plain `encoders.includes(name)`, re-run. Expected: the `hevc_qsv` test goes RED. Restore, confirm green. Record the result in the report.

- [ ] **Step 6: Commit**

```bash
git add src/protect/ffmpeg.ts test/ffmpeg.test.ts
git commit -m "feat(protect): probe ffmpeg for hardware encoding support"
```

---

## Task 2: Substream selection

**Goal:** A pure function mapping HomeKit's requested resolution to a Protect substream, honouring a per-camera override.

**Files:**
- Create: `src/accessories/quality.ts`
- Test: `test/quality.test.ts`

**Acceptance Criteria:**
- [ ] a request at or below 640×360 selects `low`
- [ ] a request at or below 1280×720 selects `medium`
- [ ] anything larger selects `high`
- [ ] an explicit override wins over the measured request
- [ ] `auto` behaves exactly as no override
- [ ] an unknown override value falls back to automatic selection rather than throwing
- [ ] the module imports nothing from HAP, Homebridge or ffmpeg

**Verify:** `npx vitest run test/quality.test.ts` → all passing

**Steps:**

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { selectQuality } from '../src/accessories/quality.js'

describe('selectQuality', () => {
  // Resolutions measured off the real console on 2026-08-01:
  // high 2688x1512, medium 1280x720, low 640x360 — all HEVC 30fps.
  it('uses the low substream for thumbnail-sized requests', () => {
    expect(selectQuality(320, 240)).toBe('low')
    expect(selectQuality(640, 360)).toBe('low')
  })

  it('uses medium for 720p, which needs no scaling at all', () => {
    expect(selectQuality(1280, 720)).toBe('medium')
  })

  it('uses high for anything larger', () => {
    expect(selectQuality(1920, 1080)).toBe('high')
    expect(selectQuality(2688, 1512)).toBe('high')
  })

  it('lets an explicit override win', () => {
    expect(selectQuality(320, 240, 'high')).toBe('high')
    expect(selectQuality(1920, 1080, 'low')).toBe('low')
  })

  it('treats auto as no override', () => {
    expect(selectQuality(1280, 720, 'auto')).toBe('medium')
  })

  it('ignores an unrecognised override instead of throwing', () => {
    expect(selectQuality(1280, 720, 'ludicrous' as never)).toBe('medium')
  })

  // A request wider than 720p but shorter than it must not be mistaken for 720p.
  it('requires BOTH dimensions to fit a tier', () => {
    expect(selectQuality(1920, 360)).toBe('high')
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/quality.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/** The Protect substreams this plugin uses. `package` exists in the API but no
 *  camera on the test hardware exposes a package camera, so it is not selected. */
export type Quality = 'low' | 'medium' | 'high'
export type QualityPreference = Quality | 'auto'

/**
 * Measured on the live console (2026-08-01): high 2688x1512, medium 1280x720,
 * low 640x360. HomeKit's most common request is 1280x720, which maps to medium
 * and therefore needs no scaling — only the mandatory HEVC to H.264 transcode.
 */
export function selectQuality(width: number, height: number, preference?: QualityPreference): Quality {
  if (preference === 'low' || preference === 'medium' || preference === 'high')
    return preference
  if (width <= 640 && height <= 360)
    return 'low'
  if (width <= 1280 && height <= 720)
    return 'medium'
  return 'high'
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run test/quality.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/accessories/quality.ts test/quality.test.ts
git commit -m "feat(accessories): pure substream selection"
```

---

## Task 3: RTSPS URL cache

**Goal:** Obtain and cache RTSPS URLs per camera and quality, creating streams on demand because Protect reports `null` for a quality until one has been created.

**Files:**
- Create: `src/protect/stream.ts`
- Test: `test/stream.test.ts`

**Acceptance Criteria:**
- [ ] returns an existing URL from `getRtspsStream` without creating one
- [ ] calls `createRtspsStream` when the requested quality is absent
- [ ] caches a URL and does not re-request it within the TTL
- [ ] re-requests after the TTL expires
- [ ] uses `performance.now()`, never `Date.now()`
- [ ] `clear()` drops all cached URLs
- [ ] a create failure propagates without the URL or API key appearing in the error message

**Verify:** `npx vitest run test/stream.test.ts` → all passing

**Steps:**

- [ ] **Step 1: Write the failing tests**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamUrls } from '../src/protect/stream.js'

const URL_HIGH = 'rtsps://192.0.2.1:7441/abc?token=SENTINEL-TOKEN'

function makeClient(existing: Record<string, string> = {}) {
  return {
    getRtspsStream: vi.fn(async () => ({ ...existing })),
    createRtspsStream: vi.fn(async () => ({ high: URL_HIGH })),
  }
}

describe('StreamUrls', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['performance'] }))

  it('returns an existing url without creating one', async () => {
    const client = makeClient({ high: URL_HIGH })
    const urls = new StreamUrls(client as never)
    expect(await urls.get('cam1', 'high')).toBe(URL_HIGH)
    expect(client.createRtspsStream).not.toHaveBeenCalled()
  })

  it('creates the stream when the quality is absent', async () => {
    const client = makeClient({})
    const urls = new StreamUrls(client as never)
    expect(await urls.get('cam1', 'high')).toBe(URL_HIGH)
    expect(client.createRtspsStream).toHaveBeenCalledWith('cam1', ['high'])
  })

  it('caches within the ttl', async () => {
    const client = makeClient({ high: URL_HIGH })
    const urls = new StreamUrls(client as never)
    await urls.get('cam1', 'high')
    await urls.get('cam1', 'high')
    expect(client.getRtspsStream).toHaveBeenCalledTimes(1)
  })

  it('re-requests after the ttl expires', async () => {
    const client = makeClient({ high: URL_HIGH })
    const urls = new StreamUrls(client as never, 60_000)
    await urls.get('cam1', 'high')
    vi.advanceTimersByTime(60_001)
    await urls.get('cam1', 'high')
    expect(client.getRtspsStream).toHaveBeenCalledTimes(2)
  })

  it('clear() drops the cache', async () => {
    const client = makeClient({ high: URL_HIGH })
    const urls = new StreamUrls(client as never)
    await urls.get('cam1', 'high')
    urls.clear()
    await urls.get('cam1', 'high')
    expect(client.getRtspsStream).toHaveBeenCalledTimes(2)
  })

  it('reports a quality the console never provides without leaking anything', async () => {
    const client = {
      getRtspsStream: vi.fn(async () => ({})),
      createRtspsStream: vi.fn(async () => ({})),
    }
    const urls = new StreamUrls(client as never)
    await expect(urls.get('cam1', 'low')).rejects.toThrow(/low/)
    await expect(urls.get('cam1', 'low')).rejects.not.toThrow(/SENTINEL-TOKEN/)
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/stream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { ProtectClient } from './client.js'
import type { Quality } from '../accessories/quality.js'

interface Entry { url: string, at: number }

/**
 * Protect returns `null` for a quality until a stream has been created with
 * POST /cameras/{id}/rtsps-stream, so a missing URL means "not created yet",
 * not "unsupported".
 *
 * The returned URLs carry an auth token. They are credentials: never log one,
 * never put one in an Error message.
 */
export class StreamUrls {
  private readonly cache = new Map<string, Entry>()

  constructor(
    private readonly client: Pick<ProtectClient, 'getRtspsStream' | 'createRtspsStream'>,
    /** Well under Protect's own stream lifetime, so a stale URL is never handed to ffmpeg. */
    private readonly ttlMs = 5 * 60_000,
  ) {}

  async get(deviceId: string, quality: Quality): Promise<string> {
    const key = `${deviceId}:${quality}`
    const hit = this.cache.get(key)
    // performance.now(), never Date.now(): this hardware NTP-steps its wall
    // clock after a power cut, which would make a fresh entry look ancient.
    if (hit && performance.now() - hit.at < this.ttlMs)
      return hit.url

    const existing = await this.client.getRtspsStream(deviceId) as Record<string, string | undefined>
    let url = existing?.[quality]
    if (!url) {
      const created = await this.client.createRtspsStream(deviceId, [quality]) as Record<string, string | undefined>
      url = created?.[quality]
    }
    if (!url)
      throw new Error(`The console did not provide a ${quality} stream for camera ${deviceId}.`)

    this.cache.set(key, { url, at: performance.now() })
    return url
  }

  clear(): void {
    this.cache.clear()
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run test/stream.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Mutation-check the clock**

Change `performance.now()` to `Date.now()` in both places and run with `vi.useFakeTimers({ toFake: ['performance'] })` as the tests do. Expected: the TTL-expiry test goes RED, because advancing fake `performance` no longer moves the clock the code reads. Restore and confirm green. Report the result — this is the exact vacuity that shipped once in this repo.

- [ ] **Step 6: Commit**

```bash
git add src/protect/stream.ts test/stream.test.ts
git commit -m "feat(protect): cache rtsps stream urls"
```

---

## Task 4: ffmpeg process supervision and redaction

**Goal:** Spawn, track and kill ffmpeg processes through one injectable seam, with stderr redacted before it can ever be logged.

**Files:**
- Modify: `src/protect/ffmpeg.ts`
- Test: `test/ffmpeg.test.ts` (extend)

**Acceptance Criteria:**
- [ ] `redactStreamUrls` replaces any `rtsp://` or `rtsps://` URL with a placeholder
- [ ] redaction survives a URL embedded mid-line in a long ffmpeg command echo
- [ ] `FfmpegProcess` spawns via an injectable function so no test launches a real process
- [ ] a non-zero exit reports an error whose message contains no URL
- [ ] `stop()` kills the process and is safe to call twice
- [ ] `activeCount` reflects running processes and returns to zero after teardown
- [ ] a planted sentinel token appears nowhere in any logged argument, verified via `util.inspect`

**Verify:** `npx vitest run test/ffmpeg.test.ts` → all passing

**Steps:**

- [ ] **Step 1: Write the failing tests**

```ts
import { EventEmitter } from 'node:events'
import { inspect } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { FfmpegProcess, redactStreamUrls } from '../src/protect/ffmpeg.js'

const SECRET = 'SENTINEL-TOKEN-DO-NOT-LOG'
const URL = `rtsps://192.0.2.1:7441/live?token=${SECRET}`

function fakeSpawn() {
  const proc = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    kill: vi.fn(),
    killed: false,
  })
  return { proc, spawn: vi.fn(() => proc) }
}

describe('redactStreamUrls', () => {
  it('removes an rtsps url', () => {
    expect(redactStreamUrls(`opening ${URL} now`)).not.toContain(SECRET)
  })

  it('removes a url from a full ffmpeg command echo', () => {
    const echo = `ffmpeg -rtsp_transport tcp -i ${URL} -c:v libx264 -f rtp srtp://...`
    const out = redactStreamUrls(echo)
    expect(out).not.toContain(SECRET)
    expect(out).toContain('-c:v libx264')
  })

  it('leaves text without urls untouched', () => {
    expect(redactStreamUrls('no url here')).toBe('no url here')
  })
})

describe('ffmpegProcess', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

  it('never lets a stream url reach the log on failure', () => {
    log.warn.mockClear()
    const { proc, spawn } = fakeSpawn()
    const p = new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: ['-i', URL], log, spawn })
    p.start()
    proc.stderr.emit('data', Buffer.from(`Error opening input ${URL}\n`))
    proc.emit('close', 1)

    const logged = inspect(log.warn.mock.calls, { depth: 10 })
    expect(logged).not.toContain(SECRET)
    expect(log.warn.mock.calls.flat().every(a => typeof a === 'string')).toBe(true)
  })

  it('tracks and releases an active slot', () => {
    const { proc, spawn } = fakeSpawn()
    const p = new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, spawn })
    p.start()
    expect(p.running).toBe(true)
    proc.emit('close', 0)
    expect(p.running).toBe(false)
  })

  it('stop() is idempotent', () => {
    const { proc, spawn } = fakeSpawn()
    const p = new FfmpegProcess({ path: '/usr/bin/ffmpeg', args: [], log, spawn })
    p.start()
    p.stop()
    p.stop()
    expect(proc.kill).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/ffmpeg.test.ts`
Expected: FAIL — `redactStreamUrls` and `FfmpegProcess` are not exported.

- [ ] **Step 3: Implement, appending to `src/protect/ffmpeg.ts`**

```ts
import type { ChildProcess } from 'node:child_process'
import { spawn as nodeSpawn } from 'node:child_process'

/**
 * ffmpeg echoes its full command line on failure, and our command line contains
 * an RTSPS URL carrying an auth token. Redaction happens BEFORE anything is
 * logged — filtering afterwards means the secret has already been formatted into
 * a string somebody may hold a reference to.
 */
export function redactStreamUrls(text: string): string {
  return text.replace(/rtsps?:\/\/\S+/gi, '<stream-url-redacted>')
}

export type SpawnFn = (command: string, args: string[]) => ChildProcess

interface FfmpegProcessOptions {
  path: string
  args: string[]
  log: { warn: (m: string) => void, debug: (m: string) => void }
  spawn?: SpawnFn
  /** Called once when the process ends, however it ends. */
  onExit?: () => void
}

export class FfmpegProcess {
  private child?: ChildProcess
  private stderr = ''
  private stopped = false

  constructor(private readonly options: FfmpegProcessOptions) {}

  get running(): boolean {
    return this.child !== undefined && !this.stopped
  }

  start(): void {
    const spawn = this.options.spawn ?? (nodeSpawn as SpawnFn)
    const child = spawn(this.options.path, this.options.args)
    this.child = child

    child.stderr?.on('data', (chunk: Buffer) => {
      // Bounded: a failing ffmpeg can produce megabytes, and this is only ever
      // used to explain a failure.
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-4000)
    })

    child.on('close', (code: number | null) => {
      this.stopped = true
      if (code !== null && code !== 0)
        this.options.log.warn(`ffmpeg exited with code ${code}: ${redactStreamUrls(this.stderr).trim().split('\n').slice(-3).join(' | ')}`)
      this.options.onExit?.()
    })

    child.on('error', (error: Error) => {
      this.stopped = true
      this.options.log.warn(`ffmpeg could not start: ${redactStreamUrls(error.message)}`)
      this.options.onExit?.()
    })
  }

  stop(): void {
    if (this.stopped || !this.child)
      return
    this.stopped = true
    this.child.kill('SIGKILL')
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run test/ffmpeg.test.ts`
Expected: PASS — Task 1's tests plus these.

- [ ] **Step 5: Mutation-check the redaction**

Replace `redactStreamUrls(this.stderr)` with `this.stderr` and re-run. Expected: the sentinel test goes RED. Restore, confirm green. Report it — this is the load-bearing test of the whole task.

- [ ] **Step 6: Commit**

```bash
git add src/protect/ffmpeg.ts test/ffmpeg.test.ts
git commit -m "feat(protect): supervise ffmpeg processes with redacted logging"
```

---

## Task 5: Streaming delegate and snapshots

**Goal:** Implement the HAP `CameraStreamingDelegate` — snapshots straight from Protect, and live sessions built from the capability probe, the URL cache and the substream selector.

**Files:**
- Create: `src/accessories/streaming.ts`
- Test: `test/streaming.test.ts`

**Acceptance Criteria:**
- [ ] `handleSnapshotRequest` returns the Protect JPEG and never spawns ffmpeg
- [ ] snapshots are cached for 2 seconds, so repeated HomeKit polls hit the console once
- [ ] a snapshot failure returns an error to HomeKit without leaking the API key
- [ ] `prepareStream` returns the addresses and SSRCs HomeKit expects
- [ ] starting a stream selects the substream from the request's resolution
- [ ] ffmpeg arguments include the hardware flags when the probe found hardware, and do not when it did not
- [ ] audio is omitted unless the camera opts in
- [ ] the concurrency cap defaults to 6 with hardware and 2 with software, and a request past the cap is refused with a logged reason rather than spawning
- [ ] stopping a stream kills its process and frees the slot

**Verify:** `npx vitest run test/streaming.test.ts && npx tsc --noEmit`

**Steps:**

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from 'vitest'
import { buildFfmpegArgs, defaultMaxStreams, StreamingDelegate } from '../src/accessories/streaming.js'

const CAPS_HW = { path: '/usr/bin/ffmpeg', encoder: 'h264_vaapi' as const, hwaccel: 'vaapi' as const }
const CAPS_SW = { path: '/usr/local/bin/ffmpeg', encoder: 'libx264' as const }
const URL = 'rtsps://192.0.2.1:7441/live?token=SENTINEL'

describe('defaultMaxStreams', () => {
  // Measured 2026-08-01: 20s of 2688x1512 costs 1.79s CPU on VAAPI, 49.1s on
  // libx264 — about 27x. A flat cap is wrong in both directions.
  it('allows more concurrent streams on hardware than software', () => {
    expect(defaultMaxStreams(CAPS_HW)).toBe(6)
    expect(defaultMaxStreams(CAPS_SW)).toBe(2)
  })
})

describe('buildFfmpegArgs', () => {
  const base = { url: URL, width: 1280, height: 720, fps: 30, bitrate: 3000, audio: false,
    address: '192.0.2.9', videoPort: 5000, videoSsrc: 1, videoKey: Buffer.alloc(30) }

  it('uses hardware flags when the probe found hardware', () => {
    const args = buildFfmpegArgs(CAPS_HW, base)
    expect(args).toContain('-hwaccel')
    expect(args).toContain('vaapi')
    expect(args.join(' ')).toContain('-c:v h264_vaapi')
  })

  it('uses no hardware flags on the software path', () => {
    const args = buildFfmpegArgs(CAPS_SW, base)
    expect(args).not.toContain('-hwaccel')
    expect(args.join(' ')).toContain('-c:v libx264')
  })

  it('omits audio unless the camera opts in', () => {
    expect(buildFfmpegArgs(CAPS_HW, base)).toContain('-an')
    expect(buildFfmpegArgs(CAPS_HW, { ...base, audio: true })).not.toContain('-an')
  })

  it('always reads rtsp over tcp', () => {
    expect(buildFfmpegArgs(CAPS_HW, base).join(' ')).toContain('-rtsp_transport tcp')
  })
})

describe('streamingDelegate snapshots', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const jpeg = Buffer.from('jpeg-bytes')

  function makeDelegate(getSnapshot = vi.fn(async () => jpeg)) {
    const client = { getSnapshot }
    const urls = { get: vi.fn(async () => URL), clear: vi.fn() }
    const delegate = new StreamingDelegate({
      deviceId: 'cam1', label: 'Driveway', log,
      client: client as never, urls: urls as never, caps: CAPS_HW,
      settings: () => ({ quality: 'auto', audio: false }),
      spawn: vi.fn(),
    })
    return { delegate, getSnapshot }
  }

  it('serves the protect jpeg without spawning ffmpeg', async () => {
    const { delegate, getSnapshot } = makeDelegate()
    const out = await delegate.snapshot()
    expect(out).toBe(jpeg)
    expect(getSnapshot).toHaveBeenCalledWith('cam1', expect.anything())
  })

  it('caches a snapshot so repeated polls hit the console once', async () => {
    const { delegate, getSnapshot } = makeDelegate()
    await delegate.snapshot()
    await delegate.snapshot()
    expect(getSnapshot).toHaveBeenCalledTimes(1)
  })

  it('surfaces a failure without leaking the api key', async () => {
    const failing = vi.fn(async () => { throw Object.assign(new Error('403'), { cause: { apiKey: 'SECRET-KEY' } }) })
    const { delegate } = makeDelegate(failing)
    await expect(delegate.snapshot()).rejects.toThrow()
    const logged = JSON.stringify(log.warn.mock.calls)
    expect(logged).not.toContain('SECRET-KEY')
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run test/streaming.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/accessories/streaming.ts`**

```ts
import type { FfmpegCapabilities, SpawnFn } from '../protect/ffmpeg.js'
import type { ProtectClient } from '../protect/client.js'
import type { StreamUrls } from '../protect/stream.js'
import type { QualityPreference } from './quality.js'
import { errorMessage } from '../protect/errors.js'
import { FfmpegProcess } from '../protect/ffmpeg.js'
import { selectQuality } from './quality.js'

/**
 * Measured on the reference host (i7-8700K, UHD 630) on 2026-08-01: 20s of
 * 2688x1512 HEVC to H.264 costs 1.79s CPU via VAAPI and 49.1s via libx264.
 * A single flat cap would be far too low for hardware and dangerously high for
 * software, where three concurrent streams would saturate a 12-thread host.
 */
export function defaultMaxStreams(caps: FfmpegCapabilities): number {
  return caps.encoder === 'libx264' ? 2 : 6
}

export interface StreamArgs {
  url: string
  width: number
  height: number
  fps: number
  bitrate: number
  audio: boolean
  address: string
  videoPort: number
  videoSsrc: number
  videoKey: Buffer
}

export function buildFfmpegArgs(caps: FfmpegCapabilities, s: StreamArgs): string[] {
  const input: string[] = ['-hide_banner', '-loglevel', 'warning']
  if (caps.hwaccel === 'vaapi')
    input.push('-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128', '-hwaccel_output_format', 'vaapi')
  else if (caps.hwaccel === 'qsv')
    input.push('-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv')

  // TCP, not UDP: Protect's RTSPS is TLS and UDP loses frames on a busy LAN.
  input.push('-rtsp_transport', 'tcp', '-i', s.url)

  const video = ['-an']
  if (s.audio)
    video.length = 0

  return [
    ...input,
    ...video,
    '-c:v', caps.encoder,
    '-b:v', `${s.bitrate}k`,
    '-payload_type', '99',
    '-ssrc', String(s.videoSsrc),
    '-f', 'rtp',
    '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
    '-srtp_out_params', s.videoKey.toString('base64'),
    `srtp://${s.address}:${s.videoPort}?rtcpport=${s.videoPort}&pkt_size=1316`,
  ]
}

export interface CameraStreamSettings {
  quality: QualityPreference
  audio: boolean
}

interface DelegateOptions {
  deviceId: string
  label: string
  log: { info: (m: string) => void, warn: (m: string) => void, debug: (m: string) => void }
  client: Pick<ProtectClient, 'getSnapshot'>
  urls: Pick<StreamUrls, 'get'>
  caps: FfmpegCapabilities
  settings: () => CameraStreamSettings
  spawn?: SpawnFn
  maxStreams?: number
}

const SNAPSHOT_TTL_MS = 2_000

export class StreamingDelegate {
  private readonly sessions = new Map<string, FfmpegProcess>()
  private snapshotCache?: { at: number, jpeg: Buffer }

  constructor(private readonly options: DelegateOptions) {}

  get activeCount(): number {
    return this.sessions.size
  }

  get maxStreams(): number {
    return this.options.maxStreams ?? defaultMaxStreams(this.options.caps)
  }

  /**
   * Protect serves JPEGs directly, so a snapshot costs no transcode at all.
   * HomeKit polls snapshots far more eagerly than expected; the short cache
   * keeps that off the console.
   */
  async snapshot(): Promise<Buffer> {
    const now = performance.now()
    if (this.snapshotCache && now - this.snapshotCache.at < SNAPSHOT_TTL_MS)
      return this.snapshotCache.jpeg
    try {
      const jpeg = await this.options.client.getSnapshot(this.options.deviceId, {})
      this.snapshotCache = { at: now, jpeg }
      return jpeg
    }
    catch (error) {
      // The string only. `log.error(err)` uses util.inspect, which would print
      // error.cause — the path that leaked the API key in this repo before.
      this.options.log.warn(`Could not fetch a snapshot for "${this.options.label}": ${errorMessage(error)}`)
      throw error
    }
  }

  startSession(sessionId: string, request: { width: number, height: number, fps: number, bitrate: number },
    rtp: { address: string, videoPort: number, videoSsrc: number, videoKey: Buffer }): boolean {
    if (this.sessions.size >= this.maxStreams) {
      this.options.log.warn(`Refusing a stream for "${this.options.label}": already running ${this.sessions.size} of a maximum ${this.maxStreams}. Raise maxStreams only if the host can take it.`)
      return false
    }
    const settings = this.options.settings()
    const quality = selectQuality(request.width, request.height, settings.quality)
    void quality
    return true
  }

  stopSession(sessionId: string): void {
    const proc = this.sessions.get(sessionId)
    proc?.stop()
    this.sessions.delete(sessionId)
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()])
      this.stopSession(id)
  }
}
```

> Note for the implementer: `startSession` above is deliberately left with the
> session wiring incomplete — the URL fetch and `FfmpegProcess` construction are
> yours to finish, because they depend on the exact HAP `PrepareStreamResponse`
> shape in the installed `hap-nodejs`. Read `CameraStreamingDelegate` in
> `node_modules/hap-nodejs/dist/lib/controller/CameraController.d.ts` and wire
> `prepareStream` / `handleStreamRequest` to these methods. Everything the tests
> above assert must pass; add tests for the session paths you complete.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run test/streaming.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Mutation-check the cap and the cache**

Force `defaultMaxStreams` to always return 6; expect the software-cap test RED. Remove the snapshot cache check; expect the caching test RED. Restore both, confirm green, report the table.

- [ ] **Step 6: Commit**

```bash
git add src/accessories/streaming.ts test/streaming.test.ts
git commit -m "feat(accessories): streaming delegate and snapshots"
```

---

## Task 6: Wire the camera controller into the platform

**Goal:** Attach a `CameraController` to every camera accessory, probe ffmpeg once at startup, and tear down all sessions on shutdown.

**Files:**
- Modify: `src/platform.ts`, `src/config.ts`
- Test: `test/platform.test.ts` (extend), `test/config.test.ts` (extend)

**Acceptance Criteria:**
- [ ] `probeFfmpeg` runs exactly once at startup, not per camera
- [ ] each camera accessory gets exactly one `CameraController`
- [ ] `registerPlatformAccessories` is used; `publishExternalAccessories` appears nowhere
- [ ] **no second Doorbell service is created** — the 2a `ring` service remains the only one
- [ ] streaming services survive a discovery cycle (they are not in `OWNED_SUBTYPES`, so the removal loop skips them)
- [ ] `shutdown` stops every active stream
- [ ] config gains per-camera `quality` and `audio`, and global `maxStreams` and `ffmpegPath`, with `audio` defaulting to `false`
- [ ] a probe failure logs a clear message and leaves sensors working rather than failing the whole platform

**Verify:** `npx vitest run test/platform.test.ts test/config.test.ts && npm run build`

**Steps:**

- [ ] **Step 1: Extend the config schema in `src/config.ts`**

```ts
// Inside deviceSettingsSchema, alongside the existing per-device settings:
  quality: z.enum(['auto', 'low', 'medium', 'high']).optional(),
  // Off unless asked for. Australian surveillance-devices law treats audio far
  // more strictly than video and varies by state; outdoor cameras capture people
  // who have not consented. Same reasoning as hksv defaulting off.
  audio: z.boolean().optional(),

// Inside configSchema, alongside host/apiKey:
  maxStreams: z.number().int().min(1).max(16).optional(),
  ffmpegPath: z.string().optional(),
```

- [ ] **Step 2: Write the failing tests**

```ts
// test/config.test.ts — append
it('defaults audio off for a camera that does not ask for it', () => {
  const parsed = parseConfig({ platform: 'UniFiProtect', host: 'h', apiKey: 'k', devices: { cam1: {} } })
  expect(parsed.success && settingsFor(parsed.data, 'cam1').audio).toBeFalsy()
})

it('accepts a per-camera quality override', () => {
  const parsed = parseConfig({ platform: 'UniFiProtect', host: 'h', apiKey: 'k', devices: { cam1: { quality: 'high' } } })
  expect(parsed.success).toBe(true)
})

it('rejects a nonsense quality', () => {
  const parsed = parseConfig({ platform: 'UniFiProtect', host: 'h', apiKey: 'k', devices: { cam1: { quality: 'ultra' } } })
  expect(parsed.success).toBe(false)
})
```

```ts
// test/platform.test.ts — append
it('probes ffmpeg once, not once per camera', async () => {
  const probe = vi.fn(async () => ({ path: '/usr/bin/ffmpeg', encoder: 'h264_vaapi', hwaccel: 'vaapi' }))
  const { accessories } = await withCameras(cameras, { probeFfmpeg: probe })
  expect(accessories.length).toBeGreaterThan(1)
  expect(probe).toHaveBeenCalledTimes(1)
})

it('adds no second doorbell service when streaming is configured', async () => {
  const { accessories } = await withCameras(cameras)
  const doorbell = accessories.find(a => a.displayName.startsWith('Doorbell'))!
  const doorbells = doorbell.services.filter(s => s.UUID === S.Doorbell)
  expect(doorbells).toHaveLength(1)
})

it('keeps sensors working when the ffmpeg probe fails', async () => {
  const probe = vi.fn(async () => { throw new Error('no usable ffmpeg') })
  const { accessories, log } = await withCameras(cameras, { probeFfmpeg: probe })
  const doorbell = accessories.find(a => a.displayName.startsWith('Doorbell'))!
  expect(doorbell.services.some(s => s.subtype === 'motion')).toBe(true)
  expect(log.warn.mock.calls.flat().join(' ')).toMatch(/ffmpeg/i)
})
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx vitest run test/platform.test.ts test/config.test.ts`
Expected: FAIL — the probe is not wired.

- [ ] **Step 4: Wire it in `src/platform.ts`**

Probe once in `didFinishLaunching`, before discovery, storing the result on the platform. In the accessory-configuration path where `buildCameraServices` is already called, additionally construct a `StreamingDelegate` and call `accessory.configureController(new this.api.hap.CameraController({ cameraStreamCount: delegate.maxStreams, delegate, streamingOptions: { /* video/audio codec parameters */ } }))`.

**Do not pass a doorbell option to `CameraController`.** Sub-project 2a already created the subtyped `ring` Doorbell, and a second one makes the doorbell appear twice in Home.app.

Wrap the probe in try/catch: a failure must log via `errorMessage()` and leave the sensor pipeline running, since sensors are useful without live view.

In `shutdown`, call `stopAll()` on every delegate before stopping the tracker.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run test/platform.test.ts test/config.test.ts && npm run build`
Expected: PASS.

- [ ] **Step 6: Mutation-check the Doorbell guard**

Pass the doorbell option to `CameraController`, re-run. Expected: the single-Doorbell test goes RED. Restore, confirm green.

- [ ] **Step 7: Commit**

```bash
git add src/platform.ts src/config.ts test/platform.test.ts test/config.test.ts
git commit -m "feat: attach camera controllers for live streaming"
```

---

## Task 7: Live verification on real Homebridge

**Goal:** Prove on the real Homebridge instance that live view and snapshots work, using hardware encoding, without leaking a stream URL into any log.

> **USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

**Acceptance Criteria:**
- [ ] the plugin loads on the real Homebridge and logs `hardware encoding (h264_vaapi)` or `(h264_qsv)` — **not** `software encoding`
- [ ] a camera snapshot appears in the Homebridge UI accessories view
- [ ] the user opens a camera in Home.app and sees live video
- [ ] a second camera opened simultaneously also plays
- [ ] `docker logs homebridge` contains zero occurrences of `rtsps://`
- [ ] host CPU during two concurrent streams stays under one core, consistent with the 1.79 s/20 s measurement
- [ ] README documents enabling hardware transcoding (`--device=/dev/dri`, the `startup.sh` install) and the software fallback's cost
- [ ] CHANGELOG has a 0.3.0 entry

**Verify:** `ssh 192.168.20.21 'docker logs homebridge --since 5m | grep -c "rtsps://"'` → `0`; user confirms live video in Home.app

**Steps:**

- [ ] **Step 1: Build, pack and deploy**

```bash
npm run build && npm pack
scp homebridge-unifi-protect-api-*.tgz 192.168.20.21:/mnt/user/appdata/homebridge/
ssh 192.168.20.21 'docker exec homebridge npm install --prefix /var/lib/homebridge /homebridge/homebridge-unifi-protect-api-*.tgz'
ssh 192.168.20.21 'docker restart homebridge'
```

Note: install to `--prefix /var/lib/homebridge`, **not** `npm install -g`. The image sets `UIX_CUSTOM_PLUGIN_PATH=/var/lib/homebridge/node_modules`; a global install is invisible to Homebridge and fails with "No plugin was found for the platform".

- [ ] **Step 2: Confirm the encoder chosen**

Run: `ssh 192.168.20.21 'docker logs homebridge --since 3m 2>&1 | grep -i "ffmpeg at"'`
Expected: a line naming `/usr/bin/ffmpeg` and `hardware encoding`. If it says software, `/dev/dri` is not reaching the container.

- [ ] **Step 3: Verify no stream URL leaked**

Run: `ssh 192.168.20.21 'docker logs homebridge --since 10m 2>&1 | grep -c "rtsps://"'`
Expected: `0`.

- [ ] **Step 4: Ask the user to open cameras in Home.app**

Ask them to open one camera, confirm live video, then open a second alongside it. While they do, capture CPU:

```bash
ssh 192.168.20.21 'top -b -n 3 -d 2 | grep -i ffmpeg'
```

Expected: each ffmpeg well under 100% of a core.

- [ ] **Step 5: Document and commit**

Update `README.md` with a hardware-transcoding section (the `--device=/dev/dri` requirement, the `startup.sh` install, and the measured 27× difference so users understand the cost of the fallback). Add a `0.3.0` entry to `CHANGELOG.md`.

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document live streaming and hardware transcoding"
```

---

## Self-review notes

- **Spec coverage:** capability probe (Task 1), substream selection (Task 2), URL cache (Task 3), process supervision and redaction (Task 4), delegate and snapshots (Task 5), platform wiring and config (Task 6), hardware gate (Task 7). The spec's benchmark gate was completed during brainstorming and its numbers are embedded in Tasks 5 and 7.
- **Talkback** is absent by design — sub-project 2c.
- **`package` quality** exists in `channelQualitySchema` but no camera on the test hardware exposes a package camera and `hasPackageCamera` is `undefined` through this API, so it is never selected.
