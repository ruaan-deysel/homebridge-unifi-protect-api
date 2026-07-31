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
    this.inFlight = this.runDiscovery().finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight.then(() => {
      if (!this.pending)
        return
      this.pending = false
      return this.discover()
    })
  }

  private async runDiscovery(): Promise<void> {
    if (!this.config || this.authFailed)
      return

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

    this.retryDelayMs = RETRY_MIN_MS
    this.reconcile(devices)
    this.startEvents()
  }

  private scheduleRetry(): void {
    if (this.retryTimer)
      return
    const delay = this.retryDelayMs
    this.retryDelayMs = Math.min(delay * 2, RETRY_MAX_MS)
    this.log.info(`Retrying discovery in ${Math.round(delay / 1000)}s.`)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
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

    for (const device of devices) {
      // `validate` degrades to the raw payload on a schema mismatch, so `id` is
      // only probably a string. `hap.uuid.generate(undefined)` throws inside
      // crypto, and this runs off a fire-and-forget promise.
      if (typeof device.id !== 'string' || device.id === '') {
        this.log.warn('Skipping a device the console returned without an id.')
        continue
      }
      if (!settingsFor(config, device.id).expose)
        continue
      wanted.set(this.api.hap.uuid.generate(device.id), device)
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
    if (devices.length === 0 && this.accessories.size > 0) {
      this.log.warn(`The console reported no devices at all while ${this.accessories.size} accessory/ies are cached. Keeping them — remove any genuinely stale accessory by hand.`)
      return
    }

    for (const [uuid, accessory] of this.accessories) {
      if (wanted.has(uuid))
        continue
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      this.accessories.delete(uuid)
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
