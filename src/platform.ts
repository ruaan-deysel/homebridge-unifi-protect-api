import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge'
import type { z } from 'zod'
import type { ProtectPluginConfig } from './config.js'
import { parseConfig, settingsFor } from './config.js'
import { ProtectClient } from './protect/client.js'
import { ProtectAuthError } from './protect/errors.js'
import { ProtectEvents } from './protect/events.js'
import { cameraSchema, chimeSchema, lightSchema, sensorSchema, viewerSchema } from './protect/schemas.js'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'

/** The fields reconciliation needs. `name` is nullable on the wire. */
export interface DiscoveredDevice {
  id: string
  name?: string | null
  modelKey: string
}

/**
 * Selects the schema for a `deviceUpdate` frame by its `modelKey`. Partial,
 * because an update frame carries only the fields that changed — the full
 * device schema would reject every real frame.
 */
const deviceSchemas = new Map<string, z.ZodType>([
  ['camera', cameraSchema.partial()],
  ['light', lightSchema.partial()],
  ['sensor', sensorSchema.partial()],
  ['chime', chimeSchema.partial()],
  ['viewer', viewerSchema.partial()],
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

function labelFor(device: DiscoveredDevice): string {
  return device.name?.trim() || `Protect ${device.modelKey} ${device.id}`
}

export class UniFiProtectPlatform implements DynamicPlatformPlugin {
  readonly accessories = new Map<string, PlatformAccessory>()
  client!: ProtectClient
  events!: ProtectEvents
  private config?: ProtectPluginConfig
  private authFailed = false
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

    this.client = new ProtectClient({ host: this.config.host, apiKey: this.config.apiKey, log: this.log })
    this.events = new ProtectEvents({ host: this.config.host, apiKey: this.config.apiKey, log: this.log })

    this.api.on('didFinishLaunching', () => this.discoverSafely())
    this.api.on('shutdown', () => {
      // Clearing the timer is not enough: a discovery still in flight can fail
      // after shutdown and schedule a fresh retry, whose `events.start()` clears
      // the bus's own `stopped` and brings the sockets back up.
      this.stopped = true
      clearTimeout(this.retryTimer)
      this.events?.stop()
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
    this.reconcile(devices)
    this.startEvents()
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

  private reconcile(devices: DiscoveredDevice[]): void {
    const config = this.config!
    const wanted = new Map<string, DiscoveredDevice>()
    // Every device the console actually reported, before the expose filter.
    const reported = new Set<string>()
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
      // Counted before the expose filter: flipping every device to
      // `expose: false` is a legitimate removal and must still unregister.
      if (!settingsFor(config, device.id).expose)
        continue
      wanted.set(uuid, device)
    }

    for (const [uuid, device] of wanted) {
      const label = labelFor(device)
      const existing = this.accessories.get(uuid)
      if (existing) {
        // Config is keyed by device id, so a rename only touches the label.
        existing.context.device = device
        if (existing.displayName !== label) {
          // Only persists to the accessory cache — it does NOT rename anything
          // in HomeKit. Sub-project 2 must drive Name/ConfiguredName for that.
          existing.displayName = label
          this.api.updatePlatformAccessories([existing])
          this.log.info(`Renamed ${device.id} to "${label}".`)
        }
        continue
      }
      // eslint-disable-next-line new-cap -- Homebridge exposes the constructor lowercased.
      const accessory = new this.api.platformAccessory(label, uuid)
      // Sub-project 2 diffs capability flags off this; services live there, not here.
      accessory.context.device = device
      // Bridged, always — never published as an external accessory. A child
      // bridge must hold every camera under one pairing.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      this.accessories.set(uuid, accessory)
      this.log.info(`Added ${device.modelKey} "${label}".`)
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
      if (wanted.has(uuid)) {
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
      this.events.on('resyncRequired', () => this.discoverSafely())
      this.events.on('deviceUpdate', (frame: unknown) => this.applyDeviceUpdate(frame))
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
  }
}
