import type { API, CameraRecordingOptions, CameraStreamingOptions, DynamicPlatformPlugin, HAP, Logging, PlatformAccessory, PlatformConfig } from 'homebridge'
import type { z } from 'zod'
import type { CameraCallbacks } from './accessories/camera.js'
import type { SensorChange } from './accessories/tracker.js'
import type { ProtectPluginConfig } from './config.js'
import type { FfmpegCapabilities, RunFfmpeg } from './protect/ffmpeg.js'
import { applyChange, buildCameraServices, isUnderstood } from './accessories/camera.js'
import { RecordingDelegate } from './accessories/recording.js'
import { routeEvent } from './accessories/router.js'
import { StreamingDelegate } from './accessories/streaming.js'
import { EventTracker } from './accessories/tracker.js'
import { parseConfig, settingsFor, storeConsoleCert } from './config.js'
import { certMismatchMessage, fetchConsoleCert, fingerprintOf } from './protect/cert.js'
import { ProtectClient } from './protect/client.js'
import { errorMessage, ProtectAuthError } from './protect/errors.js'
import { ProtectEvents } from './protect/events.js'
import { probeFfmpeg, runFfmpeg } from './protect/ffmpeg.js'
import {
  cameraPartialWithReferenceSchema,
  chimePartialWithReferenceSchema,
  lightPartialWithReferenceSchema,
  sensorPartialWithReferenceSchema,
  viewerPartialWithReferenceSchema,
} from './protect/schemas.js'
import { StreamUrls } from './protect/stream.js'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'

/** The fields reconciliation needs. `name` is nullable on the wire. */
export interface DiscoveredDevice {
  id: string
  name?: string | null
  modelKey: string
  /**
   * Whether this camera has the downward-facing package lens. A TOP-LEVEL
   * camera property, not a `featureFlags` entry — `cameraSchema` marks it
   * required — so it arrives with every inventory read and needs no probe.
   * Optional here only because `validate` degrades to the raw payload.
   */
  hasPackageCamera?: boolean
  /**
   * Feature flags. `hasSpeaker` lives HERE, not top-level — unlike
   * `hasPackageCamera`. Optional and loosely typed because `validate` degrades
   * to the raw payload when the schema does not match.
   */
  featureFlags?: { hasSpeaker?: boolean }
}

/**
 * Selects the schema for a `deviceUpdate` frame by its `modelKey`. Each
 * `...PartialWithReferenceSchema` requires only `id` and `modelKey` and marks
 * every other field optional — generated from the spec for exactly this kind
 * of delta, so it is used as-is rather than hand-rolling `.partial()` over the
 * full device schema. A real frame observed off the live console carries just
 * three keys (`id`, `modelKey`, `ledSettings`); the full device schema would
 * reject every one of them.
 */
const deviceSchemas = new Map<string, z.ZodType>([
  ['camera', cameraPartialWithReferenceSchema],
  ['light', lightPartialWithReferenceSchema],
  ['sensor', sensorPartialWithReferenceSchema],
  ['chime', chimePartialWithReferenceSchema],
  ['viewer', viewerPartialWithReferenceSchema],
])

/** Floor and ceiling for the discovery retry backoff. */
const RETRY_MIN_MS = 15_000
const RETRY_MAX_MS = 300_000

/**
 * How long a device must stay missing from the console inventory before it is
 * unregistered. Comfortably longer than a console reboot's enumeration window,
 * and short enough that a genuinely deleted camera leaves HomeKit the same day.
 */
const CONFIRM_MIN_MS = 60_000

/**
 * How long a successful LED write's value outranks a REST read of the same
 * camera. A discovery whose inventory GET was already in flight when the PATCH
 * landed comes back carrying the pre-write `ledSettings`, and caching that
 * rebuilds the switch from the stale value and visibly flips it back in
 * Home.app. Long enough to cover that in-flight read, short enough that a
 * change made in the Protect app is never ignored for a visible time.
 *
 * ponytail: a fixed window, not console-echo tracking. It self-clears, cannot
 * leak an entry, and does not depend on echo behaviour that cannot be verified
 * without the hardware in hand. Track the echo only if 10s ever proves short.
 */
const LED_WRITE_GRACE_MS = 10_000

function labelFor(device: DiscoveredDevice): string {
  return device.name?.trim() || `Protect ${device.modelKey} ${device.id}`
}

/**
 * What the camera advertises to HomeKit. The resolutions are the three Protect
 * substreams as measured on the live console (2688x1512, 1280x720, 640x360) and
 * nothing else, deliberately: the transcode does not scale, so advertising a
 * size no substream produces would promise a frame this plugin cannot send, and
 * `selectQuality` maps each of these straight back to the substream that serves it.
 */
function videoStreamingOptions(hap: HAP): CameraStreamingOptions['video'] {
  return {
    codec: {
      profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
      levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
    },
    resolutions: [
      [2688, 1512, 30],
      [1280, 720, 30],
      [640, 360, 30],
    ],
  }
}

/**
 * What the package lens advertises. 4:3 throughout, because the lens is 4:3 —
 * a 16:9 entry would promise a frame it cannot produce.
 *
 * A LADDER, and every entry at 30 fps, because Apple's HAP R2 spec (11.7,
 * 11.8.1) requires it: each advertised stream must offer at least 24 fps, and
 * Table 11-2 lists the legal 4:3 sizes as 1280x960, 1024x768, 640x480, 480x360
 * and 320x240. hap-nodejs validates NEITHER rule and encodes whatever it is
 * handed, so a non-conformant list fails completely silently — the earlier
 * single `[1600, 1200, 15]` made iOS refuse to negotiate at all: it never wrote
 * SetupEndpoints, the delegate was never called, and nothing appeared in any
 * log anywhere. Verified against real hardware: with this list iOS negotiates
 * 1280x960@30 and the stream starts.
 *
 * 1280x960 is here on top of the spec's list because HomeKit mandates the
 * 1280 width. The other mandated width, 1920, is deliberately NOT present:
 * 1920x1440 is the only 4:3 size at that width, it is 120x90 = 10800
 * macroblocks — above H.264 Level 4.0's 8192 cap, out of level for the
 * levels advertised below — and it exceeds the lens's native 1600x1200, so a
 * controller that picked it (being first in an earlier revision of this
 * list) would get a pure upscale for no benefit. Without it, every entry
 * here fits inside Level 4.0 (1600x1200 = 100x75 = 7500 macroblocks).
 * buildFfmpegArgs scales the transcode to whatever size is negotiated, so
 * every entry is a promise the encoder now keeps.
 */
function packageVideoStreamingOptions(hap: HAP): CameraStreamingOptions['video'] {
  return {
    codec: {
      profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
      levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
    },
    resolutions: [
      [1600, 1200, 30],
      [1280, 960, 30],
      [1024, 768, 30],
      [640, 480, 30],
      [480, 360, 30],
      [320, 240, 30],
    ],
  }
}

/**
 * HomeKit's own default fragment length, in milliseconds, and the value this
 * hardware was measured against. Doubles as the prebuffer length, which HAP
 * requires to be at least 4000.
 */
const HKSV_FRAGMENT_MS = 4000

/**
 * What a camera with `hksv` enabled advertises to HomeKit Secure Video.
 *
 * Audio is AAC-LC and NOTHING else. HKSV permits only AAC-LC or AAC-ELD, so
 * Opus — which live view prefers on this host, because its hardware ffmpeg
 * build carries libopus and no libfdk_aac — is illegal here. The two paths
 * differ on purpose; see `recordingArgs`, which encodes with ffmpeg's native
 * `aac` at the 32 kHz advertised below.
 *
 * `overrideEventTriggerOptions` rather than `sensors: { motion: true }`:
 * hap-nodejs derives the MOTION trigger from a CONTROLLER-owned MotionSensor,
 * and `camera.ts` already builds this camera's subtyped motion sensors off the
 * event pipeline — letting the controller add its own would show motion twice
 * in Home.app. With an empty trigger set HomeKit has nothing to start a
 * recording on, so the additive override supplies the trigger and no service.
 *
 * DOORBELL is added the same additive way, for a doorbell only. The alternative
 * — a `DoorbellController`, whose only functional difference is that its
 * `retrieveEventTriggerOptions()` adds this very bit — also constructs and OWNS
 * a primary Doorbell service, which would land beside the subtyped `ring` one
 * `camera.ts` already drives. Nothing in hap-nodejs 2.1.9 couples the bit to
 * that service: `RecordingManagement` only ORs the set into the
 * `SupportedCameraRecordingConfiguration` bitmask, and neither it nor the HDS
 * recording path ever looks for a Doorbell. The press itself still reaches
 * HomeKit through the `ring` service on the same accessory, exactly as before.
 *
 * ONLY 1280x720 is advertised, and that is deliberate. `recordingArgs` applies
 * no scale filter — it transcodes whatever substream it opens — so an
 * advertised resolution is only honest if `selectQuality` maps it to a
 * substream of exactly that size. 1280x720 maps to `medium`, which the console
 * serves at exactly 1280x720. 1920x1080 was advertised here until it was
 * noticed that `selectQuality` maps it to `high` (2688x1512), so HomeKit would
 * have negotiated 1080p and been handed something else entirely. Advertising a
 * resolution the encoder does not deliver is how the package camera earned two
 * rounds of "No Response" with nothing in the log.
 *
 * A scale filter would let the full ladder be advertised, but `scale_vaapi`
 * fails on this host with `Cannot allocate memory`, so that is not a free fix.
 *
 * KNOWN GAP, for the hardware gate: a per-camera `quality` preference
 * short-circuits `selectQuality`, so a user who forces `high` still gets
 * 2688x1512 fragments against a negotiated 1280x720.
 */
function recordingOptions(hap: HAP, doorbell: boolean): CameraRecordingOptions {
  return {
    prebufferLength: HKSV_FRAGMENT_MS,
    overrideEventTriggerOptions: doorbell
      ? [hap.EventTriggerOption.MOTION, hap.EventTriggerOption.DOORBELL]
      : [hap.EventTriggerOption.MOTION],
    mediaContainerConfiguration: {
      type: hap.MediaContainerType.FRAGMENTED_MP4,
      fragmentLength: HKSV_FRAGMENT_MS,
    },
    video: {
      type: hap.VideoCodecType.H264,
      parameters: {
        profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
        levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
      },
      resolutions: [
        [1280, 720, 30],
        [1280, 720, 15],
      ],
    },
    audio: {
      codecs: [{
        type: hap.AudioRecordingCodecType.AAC_LC,
        audioChannels: 1,
        bitrateMode: hap.AudioBitrate.VARIABLE,
        samplerate: hap.AudioRecordingSamplerate.KHZ_32,
      }],
    },
  }
}

/** The package accessory's UUID seed. Never equal to the camera's own. */
function packageSeed(deviceId: string): string {
  return `${deviceId}-package`
}

export class UniFiProtectPlatform implements DynamicPlatformPlugin {
  readonly accessories = new Map<string, PlatformAccessory>()
  client!: ProtectClient
  events!: ProtectEvents
  private config?: ProtectPluginConfig
  private authFailed = false
  private trusted = false
  /**
   * Latched on a certificate mismatch. Like `authFailed`, a retry cannot fix
   * it — only the user deciding to re-trust can, and that means a restart.
   */
  private certMismatch = false
  /** Injected in tests, so the suite never opens a TLS socket. */
  readConsoleCert = fetchConsoleCert
  /** Injected in tests, so the suite never execs a real ffmpeg. */
  probeFfmpeg = probeFfmpeg
  /** Injected in tests, for the same reason. Wrapped by `sharedRun` below. */
  runFfmpeg: RunFfmpeg = runFfmpeg
  /**
   * `ffmpeg -encoders` answers for the BINARY, not for a camera, so every
   * delegate shares one memoised run: five cameras with audio on would otherwise
   * mean five blocking execs, serially, on every discovery pass.
   *
   * ponytail: caches the promise, rejections included, for the process lifetime.
   * Identical to how the delegate already caches its own codec probe, and the
   * encoder list of a binary cannot change while that binary is in use. Key it
   * with a TTL only if an ffmpeg is ever swapped underneath a running Homebridge.
   */
  private readonly runCache = new Map<string, Promise<string>>()
  private readonly sharedRun: RunFfmpeg = (path, args) => {
    const key = `${path} ${args.join(' ')}`
    let running = this.runCache.get(key)
    if (!running) {
      running = this.runFfmpeg(path, args)
      this.runCache.set(key, running)
    }
    return running
  }

  /**
   * Undefined until the probe has run, and stays undefined if it failed — the
   * one flag that says whether live view is available at all.
   */
  private caps?: FfmpegCapabilities
  private urls?: StreamUrls
  /** Latched: the probe runs once for the platform, not per discovery or camera. */
  private probed = false
  /**
   * Accessory UUID -> its streaming delegate. Every one must be stopped on
   * shutdown: a stranded ffmpeg holds a 4 MP HEVC decode open indefinitely.
   * Also the guard against a second `configureController` on a later discovery.
   */
  private readonly delegates = new Map<string, StreamingDelegate>()
  /**
   * Accessory UUID -> its HKSV recording delegate, for the cameras that enabled
   * recording. A SEPARATE map from `delegates` only because the types differ —
   * every place that reaches into `delegates` to stop or drop a live view must
   * do the same here, and for a stronger reason: a recording delegate owns a
   * CONTINUOUSLY running ffmpeg plus a restart timer that retries forever by
   * design, so one left behind is a permanent transcode and a permanent timer.
   */
  private readonly recorders = new Map<string, RecordingDelegate>()
  private eventsStarted = false
  private busWired = false
  private inFlight?: Promise<void>
  private pending = false
  private retryTimer?: ReturnType<typeof setTimeout>
  private retryDelayMs = RETRY_MIN_MS
  private retryDriven = false
  /**
   * UUID -> a `performance.now()` reading from when it first went missing. A
   * device must stay absent for at least `confirmRemovalAfterMs` before it is
   * unregistered.
   *
   * `performance.now()`, NEVER `Date.now()`: it is monotonic and immune to
   * wall-clock steps. A Raspberry Pi has no battery-backed RTC, so after a
   * power cut it boots with a stale clock and NTP steps it — often by hours,
   * often within the first minute of uptime, which is exactly the window this
   * gate exists to survive. A forward step landing between the first-missed
   * reading and the next discovery would satisfy the gate instantly and let a
   * single partial inventory confirm itself.
   *
   * Deliberately a clock, not a discovery counter. Counting discoveries makes
   * the gate depend on discovery timing, and discoveries can arrive seconds
   * apart: `resyncRequired` fires per channel on socket open, and there are two
   * channels, so a rebooting console's reconnects can deliver two passes well
   * inside the same partial-inventory window — the second one "confirming" the
   * first and deleting everything the gate exists to protect.
   *
   * A proportional threshold ("refuse to delete more than half") is wrong at
   * both ends — far too loose on a 2-camera install, far too tight on a
   * 40-camera one — and asking the user to confirm needs UI this release does
   * not have. The only cost is that a genuinely deleted camera lingers for one
   * confirmation window; the alternative cost is a console answering mid-reboot
   * with a partial inventory irreversibly wiping rooms, scenes and automations.
   */
  private readonly pendingRemoval = new Map<string, number>()
  /**
   * Public so tests can shorten the window instead of faking an hour of clock —
   * a test that advances timers by an hour is easy to misread later.
   */
  confirmRemovalAfterMs = CONFIRM_MIN_MS
  /**
   * One-way: Homebridge never restarts a platform in-process, so there is no
   * path back. If that ever changes, clear it in `didFinishLaunching` — never
   * at construction, which runs before the shutdown it would be undoing.
   */
  private stopped = false
  /**
   * A field initialiser because it depends on nothing: no config, no client.
   * (It is never reached on the invalid-config path either — that returns
   * before any handler is registered, so nothing runs against it.)
   */
  private readonly tracker = new EventTracker()
  /**
   * Supplied to `buildCameraServices` so `camera.ts` never needs the client.
   * A rejection is handled there — it becomes a HapStatusError so HomeKit puts
   * the switch back rather than showing a state Protect refused.
   */
  /**
   * Device id -> the value a recent successful LED write asked for, and the
   * `performance.now()` reading it was written at. Read by
   * `applyRecentLedWrite` on the discovery path. `performance.now()`, never
   * `Date.now()`: an NTP step must not expire or extend the window.
   */
  private readonly recentLedWrites = new Map<string, { on: boolean, at: number }>()

  private readonly cameraCallbacks: CameraCallbacks = {
    setLed: async (deviceId, on) => {
      await this.client.patchCamera(deviceId, { ledSettings: { isEnabled: on } })
      // Covers the discovery path — see applyRecentLedWrite.
      this.recentLedWrites.set(deviceId, { on, at: performance.now() })
      // Optimistic cache update. Without this, an unrelated deviceUpdate frame
      // landing between this write and the console echoing the change back
      // rebuilds the switch from the stale cached ledSettings and flips it
      // right back in front of the user — a failed write still reverts via
      // the HapStatusError thrown in camera.ts; this only covers the success
      // path's cache.
      const accessory = this.accessories.get(this.api.hap.uuid.generate(deviceId))
      if (accessory) {
        const device = accessory.context.device as Record<string, unknown>
        const ledSettings = { ...(device.ledSettings as Record<string, unknown> | undefined), isEnabled: on }
        accessory.context.device = { ...device, ledSettings }
      }
    },
  }

  constructor(
    private readonly log: Logging,
    rawConfig: PlatformConfig,
    private readonly api: API,
  ) {
    const parsed = parseConfig(rawConfig)
    if (!parsed.success) {
      const detail = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
      this.log.error(`Configuration is invalid, the platform will not start. ${detail}`)
      return
    }
    this.config = parsed.data

    // A failsafe expiry carries no frame, so `deviceId` on the change is the
    // only thing that can route it back to an accessory.
    this.tracker.onFailsafe = changes => this.applyChanges(changes)

    // `consoleCert` may be undefined on a first run. Both transports refuse to
    // send anything until `ensureTrust` sets it — see fail-closed there.
    const shared = { host: this.config.host, apiKey: this.config.apiKey, log: this.log, consoleCert: this.config.consoleCert }
    this.client = new ProtectClient(shared)
    this.events = new ProtectEvents(shared)

    this.api.on('didFinishLaunching', () => this.discoverSafely())
    this.api.on('shutdown', () => {
      // Clearing the timer is not enough: a discovery still in flight can fail
      // after shutdown and schedule a fresh retry, whose `events.start()` clears
      // the bus's own `stopped` and brings the sockets back up.
      this.stopped = true
      clearTimeout(this.retryTimer)
      // Before anything else: an ffmpeg left running holds a 4 MP HEVC decode
      // open for as long as the host is up, and nothing else will ever kill it.
      // Guarded per delegate: one throwing stopAll() would otherwise abandon
      // every later delegate, the event bus and the failsafe timers — the exact
      // leaks this handler exists to prevent.
      for (const delegate of this.delegates.values()) {
        try {
          delegate.stopAll()
        }
        catch (error) {
          this.log.warn(`Could not stop a live view cleanly during shutdown: ${errorMessage(error)}`)
        }
      }
      // Same reason, and a stronger one: a recording encoder runs continuously,
      // and its restart timer retries forever. A snapshot of the keys, because
      // disposeRecorder deletes from the map it would otherwise be iterating.
      for (const uuid of [...this.recorders.keys()])
        this.disposeRecorder(uuid)
      this.events?.stop()
      // Every active event holds a failsafe timer. Leaked, they keep the Node
      // process alive and Homebridge never finishes shutting down.
      this.tracker.stop()
    })
  }

  /**
   * Every fire-and-forget entry point goes through here. An unhandled rejection
   * is a process exit on Node >= 15, which would take all of Homebridge down.
   */
  private discoverSafely(): void {
    this.discover().catch((error: unknown) => {
      this.log.error(`Discovery failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`)
      // Without this the plugin is permanently blind: an unexpected throw (from
      // reconcile(), say) leaves no event bus, no polling and — unlike every
      // other failure path — no retry either.
      this.scheduleRetry()
    })
  }

  /** Homebridge replays cached accessories here on startup, before discovery. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory)
  }

  /**
   * Concurrent callers (both subscriptions reconnecting at once) join the run
   * already in flight rather than racing two reconciliations over one cache,
   * and queue exactly one trailing pass — a resync that arrives mid-run would
   * otherwise be answered with REST reads that pre-date the change it exists to
   * recover, and there is no polling anywhere to catch up later.
   */
  discover(): Promise<void> {
    if (this.inFlight) {
      this.pending = true
      return this.inFlight
    }
    let trailing = false
    this.inFlight = this.runDiscovery().finally(() => {
      this.inFlight = undefined
      // Cleared here, not in the `then`: a rejecting run would otherwise leave
      // `pending` latched and buy the next caller a spurious extra pass.
      // ponytail: a trailing pass requested mid-run is therefore DROPPED when
      // the run rejects — discoverSafely's scheduleRetry() covers it, just
      // later than the resync asked for. Re-run it eagerly here only if that
      // delay ever proves to matter.
      trailing = this.pending
      this.pending = false
    })
    return this.inFlight.then(() => (trailing ? this.discover() : undefined))
  }

  private async runDiscovery(): Promise<void> {
    if (!this.config || this.authFailed || this.stopped)
      return

    // Exactly once for the whole platform. Per camera it would exec ffmpeg twice
    // for every camera on every discovery, and the answer is a property of the
    // host, not of any one camera.
    if (!this.probed) {
      this.probed = true
      await this.prepareStreaming()
    }

    // Before anything that carries the API key. A mismatch stops here, so the
    // credential is never offered to a console that is not the trusted one.
    if (!await this.ensureTrust())
      return

    // Captured up front: a retry-driven pass must not reset the backoff, or a
    // proxy that permanently 401s the WebSocket upgrade while REST stays healthy
    // loops at the floor delay forever — every retry succeeding at REST.
    const retryDriven = this.retryDriven
    this.retryDriven = false

    let devices: DiscoveredDevice[]
    try {
      const info = await this.client.getMetaInfo()
      this.log.info(`Connected to UniFi Protect ${info.applicationVersion} at ${this.config.host}.`)
      devices = await this.fetchInventory()
    }
    catch (error) {
      if (error instanceof ProtectAuthError) {
        this.authFailed = true
        this.log.error('Protect rejected the API key. Regenerate it in UniFi Site Manager → Integrations, then restart Homebridge.')
        return
      }
      // Console unreachable. Keep every cached accessory — a rebooting console
      // must not wipe HomeKit rooms, scenes and automations.
      this.log.warn(`Could not reach the Protect console, keeping existing accessories. ${(error as Error).message}`)
      // Without this the plugin is dead until Homebridge restarts: no bus means
      // no resyncRequired, and nothing else ever retries. A power cut boots the
      // Pi well before the console.
      this.scheduleRetry()
      return
    }

    // Re-checked, because the guard at the top of this method ran before the
    // awaits above. A shutdown during a *successful* discovery would otherwise
    // fall straight through and restart the sockets the handler just stopped.
    // Anything resuming after an await must re-confirm the platform is alive.
    if (this.stopped)
      return

    if (!retryDriven)
      this.retryDelayMs = RETRY_MIN_MS
    await this.reconcile(devices)
    // Re-checked again: reconcile() attaches accessories and awaits an ffmpeg
    // probe per camera, which is easily long enough for shutdown to land. Bring
    // the sockets up after that and Homebridge never finishes shutting down.
    if (this.stopped)
      return
    this.startEvents()
  }

  /**
   * Trust on first use, pin afterwards.
   *
   * The certificate is read over a TLS handshake that sends nothing (see
   * `fetchConsoleCert`), so this runs before the API key is ever offered. It is
   * what produces the readable mismatch message; the actual protection is the
   * per-connection pinning in both transports, which would refuse a swapped
   * certificate even if this check were removed.
   */
  private async ensureTrust(): Promise<boolean> {
    if (this.trusted)
      return true
    if (this.certMismatch)
      return false

    const config = this.config!
    let presented
    try {
      presented = await this.readConsoleCert(config.host)
    }
    catch (error) {
      this.log.warn(`Could not read the certificate of the console at ${config.host}. ${error instanceof Error ? error.message : String(error)}`)
      this.scheduleRetry()
      return false
    }
    if (this.stopped)
      return false

    const stored = config.consoleCert
    if (stored && fingerprintOf(stored) !== presented.fingerprint) {
      // Fail closed. Silently re-trusting here would undo the entire point.
      this.certMismatch = true
      this.log.error(certMismatchMessage(config.host, fingerprintOf(stored), presented.fingerprint))
      return false
    }

    this.applyTrust(stored ?? presented.pem)
    if (!stored) {
      config.consoleCert = presented.pem
      this.log.info(`Trusting the certificate of the UniFi console at ${config.host} — SHA-256 ${presented.fingerprint}. Compare it with the fingerprint your console shows if you want to be certain; every later connection is pinned to it.`)
      this.persistTrust(config.host, presented.pem)
    }
    return true
  }

  private applyTrust(pem: string): void {
    this.trusted = true
    this.client.consoleCert = pem
    this.events.consoleCert = pem
  }

  private persistTrust(host: string, pem: string): void {
    const configPath = this.api.user?.configPath?.()
    try {
      if (!configPath)
        throw new Error('Homebridge did not report a config path')
      storeConsoleCert(configPath, host, pem)
    }
    catch (error) {
      // Not fatal: the certificate is trusted for this session either way, it
      // just gets re-learned (and re-logged) after a restart.
      this.log.warn(`Trusted the console certificate for this session but could not save it to config.json (${error instanceof Error ? error.message : String(error)}). It will be trusted again on the next restart.`)
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.stopped)
      return
    const delay = this.retryDelayMs
    this.retryDelayMs = Math.min(delay * 2, RETRY_MAX_MS)
    this.log.info(`Retrying discovery in ${Math.round(delay / 1000)}s.`)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.retryDriven = true
      this.discoverSafely()
    }, delay)
    // A pending retry must never hold the process open.
    this.retryTimer.unref?.()
  }

  private async fetchInventory(): Promise<DiscoveredDevice[]> {
    const [cameras, lights, sensors, chimes, viewers] = await Promise.all([
      this.client.getCameras(),
      this.client.getLights(),
      this.client.getSensors(),
      this.client.getChimes(),
      this.client.getViewers(),
    ])
    // Console inventory, before the expose filter — "Added" lines below report
    // what actually reached HomeKit.
    this.log.info(`The console reports ${cameras.length} camera(s), ${lights.length} light(s), ${sensors.length} sensor(s), ${chimes.length} chime(s), ${viewers.length} viewer(s).`)
    return [...cameras, ...lights, ...sensors, ...chimes, ...viewers] as DiscoveredDevice[]
  }

  /**
   * Returns the device with a still-fresh LED write applied over whatever the
   * console reported. A copy, never a mutation — the caller's object comes
   * straight out of the client's response.
   */
  private applyRecentLedWrite(device: DiscoveredDevice): DiscoveredDevice {
    const recent = this.recentLedWrites.get(device.id)
    if (!recent)
      return device
    if (performance.now() - recent.at >= LED_WRITE_GRACE_MS) {
      this.recentLedWrites.delete(device.id)
      return device
    }
    const raw = device as unknown as Record<string, unknown>
    const ledSettings = { ...(raw.ledSettings as Record<string, unknown> | undefined), isEnabled: recent.on }
    return { ...raw, ledSettings } as unknown as DiscoveredDevice
  }

  /**
   * Finds the ffmpeg live view will use and prepares the shared stream-URL
   * cache. NEVER rejects and never throws: sensors, switches and the doorbell
   * are useful without live view, so a host with no usable ffmpeg must still
   * run everything else rather than failing the platform.
   */
  private async prepareStreaming(): Promise<void> {
    try {
      this.caps = await this.probeFfmpeg({ log: this.log, configuredPath: this.config!.ffmpegPath })
      this.urls = new StreamUrls(this.client)
    }
    catch (error) {
      // errorMessage, and the STRING: Homebridge's log.error(err) runs
      // util.inspect over the object, which has leaked the API key out of an
      // error's request context in this repo before.
      this.log.warn(`No usable ffmpeg, so live view and snapshots are disabled. Sensors, switches and the doorbell keep working. ${errorMessage(error)}`)
    }
  }

  /**
   * Gives a camera accessory its `CameraController`, once.
   *
   * A `CameraController` and NOT a `DoorbellController`: sub-project 2a already
   * builds the subtyped `ring` Doorbell service and drives it off the event
   * pipeline, and a controller-owned second one makes the doorbell appear twice
   * in Home.app.
   */
  private async attachStreaming(accessory: PlatformAccessory, device: DiscoveredDevice): Promise<void> {
    // No usable ffmpeg means no live view for anyone; already-wired means a
    // later discovery, and configuring a second controller would duplicate
    // every stream management service on the accessory.
    // `stopped` too: shutdown has already stopped every delegate it knew about,
    // so one attached after it would never be stopped by anything.
    if (!this.caps || this.stopped || this.delegates.has(accessory.UUID))
      return

    const label = accessory.displayName
    // The SAME predicate `camera.ts`'s `desiredSubtypes` uses to decide whether
    // this device gets a `ring` Doorbell service at all — only a doorbell has a
    // speaker on this hardware. Reused so the DOORBELL recording trigger is
    // advertised exactly when a Doorbell service exists to fire it.
    const isDoorbell = device.featureFlags?.hasSpeaker === true
    const delegate = new StreamingDelegate({
      deviceId: device.id,
      label,
      log: this.log,
      client: this.client,
      urls: this.urls!,
      caps: this.caps,
      maxStreams: this.config!.maxStreams,
      // Shared across every camera: which encoders a build has is a property of
      // the BINARY, not of any camera.
      run: this.sharedRun,
      // Read on every stream request, never snapshotted at construction, so the
      // delegate can never answer from a stale copy of the settings.
      settings: () => {
        const settings = settingsFor(this.config!, device.id)
        return { quality: settings.quality, audio: settings.audio, talkback: settings.talkback }
      },
      hasSpeaker: isDoorbell,
    })
    // Claimed before the await below, so a discovery arriving mid-probe cannot
    // build a second controller for the same accessory.
    this.delegates.set(accessory.UUID, delegate)

    // Inside the try, together with configureController: the probe execs
    // ffmpeg, and a failure there must degrade this camera to video-only —
    // never abort the whole discovery pass and take every other device with it.
    try {
      // The delegate's own, never hand-built here: it advertises a codec only
      // when the camera opted in AND this ffmpeg can actually encode it, so the
      // advertisement cannot drift from the arguments sent.
      const audio = await delegate.audioStreamingOptions()
      // Silence otherwise. HAP encodes SupportedAudioStreamConfiguration into the
      // stream management services (and creates the Microphone service) when the
      // controller is configured, and `CameraController.streamingOptions` is
      // private and read-only — there is no supported way to re-advertise codecs
      // afterwards. So this advertisement is fixed for the life of the process:
      // turning audio OFF takes effect on the next stream request, turning it ON
      // needs the restart Homebridge already prompts for when settings are saved.
      if (!audio && settingsFor(this.config!, device.id).audio) {
        this.log.warn(`Audio is enabled for "${label}" but no codec HomeKit accepts could be advertised, so live view will be video-only. The ffmpeg at ${this.caps.path} can encode neither libopus nor libfdk_aac.`)
      }

      // Only where the user turned it on. A recording delegate is a
      // continuously running ffmpeg per camera, so building one for a camera
      // that did not ask for it is a permanent transcode nobody wanted.
      const recorder = settingsFor(this.config!, device.id).hksv
        ? new RecordingDelegate({
            deviceId: device.id,
            label,
            log: this.log,
            urls: this.urls!,
            caps: this.caps,
            // Both read on every encoder start, never snapshotted, so a setting
            // changed in the UI takes effect on the next restart rather than
            // needing a whole Homebridge restart.
            audioActive: () => settingsFor(this.config!, device.id).audio,
            quality: () => settingsFor(this.config!, device.id).quality,
          })
        : undefined

      accessory.configureController(new this.api.hap.CameraController({
        cameraStreamCount: delegate.maxStreams,
        delegate,
        streamingOptions: {
          supportedCryptoSuites: [this.api.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
          video: videoStreamingOptions(this.api.hap),
          audio,
        },
        // Absent entirely when recording is off — an empty object here would
        // still make hap-nodejs build the whole RecordingManagement. hap-nodejs
        // creates the CameraOperatingMode service itself from this; never add
        // it by hand.
        ...(recorder ? { recording: { options: recordingOptions(this.api.hap, isDoorbell), delegate: recorder } } : {}),
      }))
      // AFTER configureController, so a throw from it leaves nothing registered
      // that the removal sweep would have to clean up.
      if (recorder) {
        this.recorders.set(accessory.UUID, recorder)
        this.log.info(`HomeKit Secure Video is enabled for "${label}".`)
      }
    }
    catch (error) {
      this.delegates.delete(accessory.UUID)
      // errorMessage, and the STRING — see prepareStreaming.
      this.log.warn(`Could not enable live view for "${label}": ${errorMessage(error)}`)
    }
  }

  /**
   * Registers the Doorbell's downward-facing package lens as its own bridged
   * accessory, and returns the UUID it belongs under so `reconcile`'s removal
   * sweep keeps it — nothing in the console inventory carries that UUID, so
   * without the return value the sweep would unregister it.
   *
   * A camera and NOTHING else: no motion sensor, no doorbell, no LED switch.
   * `buildCameraServices` is deliberately never called for it — in particular
   * the "Doorbell Package" motion sensor stays on the MAIN accessory, because
   * moving a service between accessories reads to HomeKit as the old one
   * disappearing and breaks the user's automations.
   */
  private async attachPackageCamera(device: DiscoveredDevice): Promise<string | undefined> {
    const uuid = this.api.hap.uuid.generate(packageSeed(device.id))
    // BOTH removals first, ABOVE the ffmpeg guard: unticking the setting and
    // the console dropping the lens are genuine "this no longer belongs", and
    // must still unregister even while ffmpeg is unavailable.
    if (!settingsFor(this.config!, device.id).packageCamera)
      return
    // Straight off the payload this loop is already holding — no request of any
    // kind. Asking the console instead would mean a POST that CREATES a package
    // RTSPS stream, against every camera, on every startup, to learn something
    // already in hand. `=== true` and not a truthiness check: `validate`
    // degrades to the raw response when cameraSchema fails, so on that path the
    // field can be missing or any type at all.
    if (device.hasPackageCamera !== true)
      return
    // No usable ffmpeg means no live view for anyone. `urls` too: both are set
    // together in prepareStreaming, and the delegate needs it. An already
    // registered package accessory that still belongs is kept anyway
    // (controller-less) — the outage is transient, and unregistering here would
    // be immediate (see `reconcile`'s `reported` set) and permanently drop the
    // user's HomeKit room/scene/automation membership over a startup blip. A
    // package accessory that does not exist yet is not created for a camera
    // with no usable ffmpeg: that is a genuine "nothing to show yet".
    if (!this.caps || !this.urls)
      return this.accessories.has(uuid) ? uuid : undefined

    const label = `${labelFor(device)} Package Camera`
    // From here on the accessory belongs in HomeKit, so the UUID is returned
    // even when wiring it up fails or shutdown lands mid-pass: the removal
    // sweep must not delete an accessory that is only temporarily unwired.
    try {
      let accessory = this.accessories.get(uuid)
      if (!accessory) {
        // eslint-disable-next-line new-cap -- Homebridge exposes the constructor lowercased.
        accessory = new this.api.platformAccessory(label, uuid)
        // Bridged, always — never published as an external accessory, which
        // would be a separate pairing the user has to add by hand.
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
        this.accessories.set(uuid, accessory)
        this.log.info(`Added the package camera "${label}".`)
      }
      else if (accessory.displayName !== label) {
        // Renaming the camera in Protect must not leave this one behind.
        accessory.displayName = label
        this.api.updatePlatformAccessories([accessory])
      }
      accessory.context.device = device

      // Same guard as buildCameraServices: only from a payload we understood.
      // A degraded one has no `mac`, and a changed SerialNumber makes HomeKit
      // treat this as a different accessory.
      const raw = device as unknown as Record<string, unknown>
      if (isUnderstood(raw)) {
        const { Characteristic: C, Service: S } = this.api.hap
        const info = accessory.getService(S.AccessoryInformation) ?? accessory.addService(S.AccessoryInformation)
        // Suffixed like `packageSeed`'s UUID: two bridged accessories sharing a
        // serial is one accessory as far as HomeKit's identity tracking cares.
        info.setCharacteristic(C.Manufacturer, 'Ubiquiti')
          .setCharacteristic(C.Model, typeof raw.modelKey === 'string' ? raw.modelKey : 'camera')
          .setCharacteristic(C.SerialNumber, `${typeof raw.mac === 'string' ? raw.mac : String(device.id ?? 'unknown')}-package`)
      }

      // Already wired means a later discovery; `stopped` means shutdown has
      // already stopped every delegate it knew about, so one attached now would
      // never be stopped by anything.
      if (this.delegates.has(uuid) || this.stopped)
        return uuid

      const delegate = new StreamingDelegate({
        deviceId: device.id,
        label,
        log: this.log,
        client: this.client,
        urls: this.urls,
        caps: this.caps,
        maxStreams: this.config!.maxStreams,
        run: this.sharedRun,
        // The delegate ignores quality on this channel (the lens has one
        // stream) and refuses audio outright, but the shape is shared.
        settings: () => {
          const settings = settingsFor(this.config!, device.id)
          return { quality: settings.quality, audio: settings.audio, talkback: settings.talkback }
        },
        channel: 'package',
      })
      // Keyed by the package UUID in the SAME map, so the shutdown handler's
      // existing loop stops this delegate with no change: a stranded ffmpeg
      // holds a decode open indefinitely.
      this.delegates.set(uuid, delegate)

      accessory.configureController(new this.api.hap.CameraController({
        cameraStreamCount: delegate.maxStreams,
        delegate,
        streamingOptions: {
          supportedCryptoSuites: [this.api.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
          video: packageVideoStreamingOptions(this.api.hap),
          // No `audio` key at all: the lens shares the main camera's microphone,
          // so a second identical audio source benefits nobody.
        },
        // No doorbell option: sub-project 2a already builds the subtyped `ring`
        // Doorbell on the MAIN accessory, and a second makes the doorbell
        // appear twice in Home.app.
      }))
    }
    catch (error) {
      this.delegates.delete(uuid)
      // errorMessage, and the STRING — see prepareStreaming. One camera failing
      // must not abort discovery for every other device.
      this.log.warn(`Could not enable the package camera for "${label}": ${errorMessage(error)}`)
    }
    return uuid
  }

  /**
   * Stops and forgets an accessory's recording delegate, if it has one.
   *
   * `updateRecordingActive(false)` IS the disposal, with no new logic behind it:
   * it clears the restart timer, stops the process, runs `teardown()` — which
   * closes every open HDS stream and clears the prebuffer — and leaves
   * `active = false`, so a `scheduleRestart` already in flight returns early.
   *
   * Guarded, for the same reason the live-view stop beside it is: one throwing
   * must not abandon the rest of the shutdown or the unregistration.
   *
   * The entry is dropped LAST, and only once the encoder is really gone. A
   * `kill()` that was not delivered is honoured everywhere else in this feature
   * — `stopEncoder` keeps the process handle precisely so a later stop can retry
   * — and deleting the map entry first defeated that: the delegate holding the
   * only handle became unreachable, no later attempt could exist, and the ffmpeg
   * outlived the accessory and the plugin. `encoding` is the runtime observable
   * of exactly that state, so a delegate that still has a live process stays in
   * the map for the next disposal (accessory removal, then shutdown) to retry.
   */
  private disposeRecorder(uuid: string): void {
    const recorder = this.recorders.get(uuid)
    if (!recorder)
      return
    try {
      recorder.updateRecordingActive(false)
    }
    catch (error) {
      // errorMessage, and the STRING — see prepareStreaming.
      this.log.warn(`Could not stop the recording encoder of "${this.accessories.get(uuid)?.displayName ?? uuid}" cleanly: ${errorMessage(error)}`)
    }
    if (recorder.encoding) {
      this.log.warn(`The recording encoder of "${this.accessories.get(uuid)?.displayName ?? uuid}" could not be stopped and may still be running; it will be retried on shutdown.`)
      return
    }
    this.recorders.delete(uuid)
  }

  private async reconcile(devices: DiscoveredDevice[]): Promise<void> {
    const config = this.config!
    const wanted = new Map<string, DiscoveredDevice>()
    // Every device the console actually reported, before the expose filter.
    const reported = new Set<string>()
    /**
     * Package accessories that still belong. They carry a UUID no console
     * device ever will, so they are kept by this set alone — and dropping out
     * of it (the setting switched off, the lens gone) is what removes them.
     */
    const packages = new Set<string>()
    let usable = 0

    for (const device of devices) {
      // `validate` degrades to the raw payload on a schema mismatch, so `id` is
      // only probably a string. `hap.uuid.generate(undefined)` throws inside
      // crypto, and this runs off a fire-and-forget promise.
      if (typeof device.id !== 'string' || device.id === '') {
        this.log.warn('Skipping a device the console returned without an id.')
        continue
      }
      usable++
      const uuid = this.api.hap.uuid.generate(device.id)
      reported.add(uuid)
      // The parent camera is in the inventory, so its package accessory is
      // "reported" too: switching the setting off then takes effect at once,
      // exactly like `expose: false`, rather than waiting out the removal
      // confirmation window meant for a console that answered mid-reboot.
      reported.add(this.api.hap.uuid.generate(packageSeed(device.id)))
      // Counted before the expose filter: flipping every device to
      // `expose: false` is a legitimate removal and must still unregister.
      if (!settingsFor(config, device.id).expose)
        continue
      wanted.set(uuid, device)
    }

    for (const [uuid, reportedDevice] of wanted) {
      // Before anything caches or re-diffs it: a REST read that raced a LED
      // write carries the pre-write ledSettings, and `wireLed` would push that
      // stale value straight back onto the switch.
      const device = this.applyRecentLedWrite(reportedDevice)
      const label = labelFor(device)
      let accessory = this.accessories.get(uuid)
      if (accessory) {
        // Config is keyed by device id, so a rename only touches the label.
        accessory.context.device = device
        if (accessory.displayName !== label) {
          // Only persists to the accessory cache — it does NOT rename anything
          // in HomeKit. Sub-project 2 must drive Name/ConfiguredName for that.
          accessory.displayName = label
          this.api.updatePlatformAccessories([accessory])
          this.log.info(`Renamed ${device.id} to "${label}".`)
        }
      }
      else {
        // eslint-disable-next-line new-cap -- Homebridge exposes the constructor lowercased.
        accessory = new this.api.platformAccessory(label, uuid)
        accessory.context.device = device
        // Bridged, always — never published as an external accessory. A child
        // bridge must hold every camera under one pairing.
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
        this.accessories.set(uuid, accessory)
        this.log.info(`Added ${device.modelKey} "${label}".`)
      }
      // Existing accessories too, not only new ones: a detection type toggled
      // in Protect only reaches HomeKit if the surviving accessory is re-diffed.
      // `buildCameraServices` is idempotent and applies its own floor against a
      // degraded payload, so it removes nothing it did not understand.
      if (device.modelKey === 'camera') {
        buildCameraServices(this.api, this.log, accessory, device as unknown as Record<string, unknown>, this.cameraCallbacks)
        // Cameras only: a light or a chime has nothing to stream, and a
        // CameraController on one would offer HomeKit a live view of nothing.
        await this.attachStreaming(accessory, device)
        const packageUuid = await this.attachPackageCamera(device)
        if (packageUuid)
          packages.add(packageUuid)
      }
    }

    // Belt to the client's braces. An inventory that is empty while the cache is
    // not is far more likely a console answering during a reboot than a user who
    // deleted every device at once — and unregistering is irreversible: HomeKit
    // rooms, scenes and automations do not come back.
    // ponytail: a user who genuinely removes their last Protect device must
    // delete that one accessory by hand. A vastly better failure than the other.
    // `usable`, not `devices.length` — an array of id-less objects is just as
    // broken a response as an empty one, and would wipe the cache identically.
    if (usable === 0 && this.accessories.size > 0) {
      this.log.warn(`The console reported no usable devices while ${this.accessories.size} accessory/ies are cached. Keeping them — remove any genuinely stale accessory by hand.`)
      return
    }

    for (const [uuid, accessory] of this.accessories) {
      if (wanted.has(uuid) || packages.has(uuid)) {
        // Back in the inventory — whatever made it vanish was transient.
        this.pendingRemoval.delete(uuid)
        continue
      }
      // Still reported by the console, just filtered out by `expose: false`.
      // That is the user's own explicit instruction, not a partial inventory,
      // so it takes effect now — deferring it would strand the accessory until
      // some unrelated event happened to trigger a second discovery.
      const firstMissed = this.pendingRemoval.get(uuid)
      if (!reported.has(uuid) && (firstMissed === undefined || performance.now() - firstMissed < this.confirmRemovalAfterMs)) {
        if (firstMissed === undefined) {
          this.pendingRemoval.set(uuid, performance.now())
          this.log.info(`"${accessory.displayName}" is missing from the console inventory. Keeping it until a later discovery agrees.`)
        }
        continue
      }
      // Before unregistering: an ffmpeg for an accessory that no longer exists
      // is never stopped by anything, and a delegate left in the map would make
      // `attachStreaming` skip the re-added accessory as "already wired".
      const delegate = this.delegates.get(uuid)
      if (delegate) {
        this.delegates.delete(uuid)
        try {
          delegate.stopAll()
        }
        catch (error) {
          this.log.warn(`Could not stop the live view of "${accessory.displayName}" while removing it: ${errorMessage(error)}`)
        }
      }
      // Same, and it matters more: the restart policy retries indefinitely by
      // design, so a recorder left behind is one live timer plus a retained
      // delegate for the life of the process — and a HEALTHY encoder for a
      // removed camera would never stop at all, because a long run zeroes the
      // failure tally.
      this.disposeRecorder(uuid)
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      this.accessories.delete(uuid)
      this.pendingRemoval.delete(uuid)
      this.log.info(`Removed "${accessory.displayName}".`)
    }
  }

  private startEvents(): void {
    if (this.eventsStarted)
      return
    this.eventsStarted = true

    // Wiring is separate from starting: `start()` clears the bus's own latched
    // auth failure, so it can legitimately be called more than once, but the
    // listeners must be attached exactly once.
    if (!this.busWired) {
      this.busWired = true
      // Frames missed while a socket was down are never replayed, so a reconnect
      // must be followed by a full REST discovery pass.
      this.events.on('resyncRequired', () => {
        // There is no `GET /v1/events` on this API, so an event left open across
        // a dropped socket can never be reconciled by polling — only assumed
        // over. Clearing early beats a sensor stuck on until the failsafe.
        this.applyChanges(this.tracker.clearAll())
        this.discoverSafely()
      })
      this.events.on('deviceUpdate', (frame: unknown) => this.applyDeviceUpdate(frame))
      this.events.on('protectEvent', (frame: unknown) => this.applyProtectEvent(frame))
      // The bus latches internally on a 401 and stops retrying. Without this the
      // subscriptions die while REST still works, and HomeKit goes stale
      // forever — there is no polling fallback anywhere in this plugin.
      this.events.on('authFailed', () => {
        this.log.error('The Protect console rejected the API key on the event subscriptions. HomeKit will not see live changes until they reconnect.')
        this.eventsStarted = false
        this.scheduleRetry()
      })
    }
    this.events.start()
  }

  /** Frames arrive unvalidated. Nothing in here may throw back into the socket. */
  private applyProtectEvent(frame: unknown): void {
    try {
      const routed = routeEvent(frame)
      if (!routed)
        return
      // Silently. A chime, an unadopted device, or a camera the user set
      // `expose: false` on emits these constantly, and this runs per frame —
      // logging would drown the log in noise nobody can act on.
      //
      // Gated before `apply`, so an unexposed camera never accumulates tracker
      // entries or failsafe timers for sensors that do not exist.
      if (!this.accessories.has(this.api.hap.uuid.generate(routed.deviceId)))
        return
      this.applyChanges(this.tracker.apply(routed))
    }
    catch (error) {
      // errorMessage, and the STRING: Homebridge's log.error(err) runs
      // util.inspect over the object, which has leaked the API key out of an
      // error's request context in this repo before.
      this.log.warn(`Discarding an event frame that could not be handled: ${errorMessage(error)}`)
    }
  }

  /**
   * Guarded here rather than at each call site so every caller is covered. Two
   * of them cannot survive a throw: `onFailsafe` runs inside a `setTimeout`,
   * where a throw is an uncaught exception and a process exit — Homebridge
   * dies, not just the sensor — and the `resyncRequired` listener would skip
   * the `discoverSafely()` that resync exists to trigger.
   */
  private applyChanges(changes: SensorChange[]): void {
    try {
      for (const change of changes) {
        const accessory = this.accessories.get(this.api.hap.uuid.generate(change.deviceId))
        if (accessory) {
          applyChange(this.api, accessory, change)
          this.logSensorChange(accessory.displayName, change)
        }
      }
    }
    catch (error) {
      // errorMessage, and the STRING: Homebridge's log.error(err) runs
      // util.inspect over the object, which has leaked the API key out of an
      // error's request context in this repo before.
      this.log.warn(`Could not apply a sensor change: ${errorMessage(error)}`)
    }
  }

  /**
   * The success path, logged. Motion is the trigger for every HKSV recording,
   * and it used to reach HomeKit in total silence — so when a walk past a
   * camera produced no clip there was no way to tell from the log whether
   * motion had fired at all or HomeKit had ignored it. Talkback shipped with
   * exactly that hole and it cost a hardware-gate round.
   *
   * `subtype` is this plugin's own string ('motion', 'smart-person', 'ring',
   * 'audio-alrmSmoke'…), never console-supplied text, so it is safe to log.
   * The display name comes from the console and is attacker-controlled, but a
   * log line is not markup and Homebridge escapes nothing — it is quoted for
   * readability only.
   *
   * Motion START at info because that is the line a user watching a hardware
   * test needs to see without turning on debug. Everything else — the clear,
   * and every non-motion sensor — at debug, or five outdoor cameras would fill
   * the log with a line per passing car.
   */
  private logSensorChange(label: string, change: SensorChange): void {
    if (change.subtype === 'motion' && change.active)
      this.log.info(`Motion detected on "${label}".`)
    else
      this.log.debug(`Sensor "${change.subtype}" on "${label}" is now ${change.active ? 'active' : 'clear'}.`)
  }

  /** Frames arrive unvalidated. Nothing in here may throw back into the socket. */
  private applyDeviceUpdate(frame: unknown): void {
    const item = (frame as { item?: unknown })?.item
    const modelKey = (item as { modelKey?: unknown })?.modelKey
    if (typeof modelKey !== 'string')
      return

    // A Map, not an object: `modelKey: "constructor"` would find an inherited
    // function on a plain object's prototype, pass the falsy check, and throw
    // out of a handler that must never throw.
    const schema = deviceSchemas.get(modelKey)
    if (!schema)
      return

    const parsed = schema.safeParse(item)
    if (!parsed.success) {
      this.log.debug(`Ignoring a malformed ${modelKey} update frame.`)
      return
    }

    const update = parsed.data as Partial<DiscoveredDevice>
    if (typeof update.id !== 'string')
      return

    const accessory = this.accessories.get(this.api.hap.uuid.generate(update.id))
    if (!accessory)
      return

    // Merge — the frame is a delta, not the whole device.
    const device = Object.assign({}, accessory.context.device as DiscoveredDevice, update)
    accessory.context.device = device
    const label = labelFor(device)
    if (accessory.displayName !== label) {
      accessory.displayName = label
      this.api.updatePlatformAccessories([accessory])
      this.log.info(`Renamed ${device.id} to "${label}".`)
    }

    // Re-diff the same way reconcile() does. This is how a `ledSettings` change
    // made in the Protect app — or any other field a deviceUpdate frame carries —
    // reaches the switch: buildCameraServices is idempotent and re-applies its
    // own understood/degraded floor, so this never removes a service the merge
    // did not genuinely justify removing.
    //
    // Guarded like `applyChanges` above: `addService`/`removeService`/
    // `updateCharacteristic` are HAP calls and this method's own docblock
    // promises nothing in here throws back into the bare socket listener.
    if (modelKey === 'camera') {
      try {
        buildCameraServices(this.api, this.log, accessory, device as unknown as Record<string, unknown>, this.cameraCallbacks)
      }
      catch (error) {
        // errorMessage, and the STRING: Homebridge's log.error(err) runs
        // util.inspect over the object, which has leaked the API key out of an
        // error's request context in this repo before.
        this.log.warn(`Could not rebuild services for "${label}": ${errorMessage(error)}`)
      }
    }
  }
}
