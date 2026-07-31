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
const deviceSchemas: Record<string, z.ZodType> = {
  camera: cameraSchema.partial(),
  light: lightSchema.partial(),
  sensor: sensorSchema.partial(),
  chime: chimeSchema.partial(),
  viewer: viewerSchema.partial(),
}

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
  private inFlight?: Promise<void>

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

    this.api.on('didFinishLaunching', () => void this.discover())
    this.api.on('shutdown', () => this.events?.stop())
  }

  /** Homebridge replays cached accessories here on startup, before discovery. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory)
  }

  /**
   * Concurrent callers (both subscriptions reconnecting at once) join the run
   * already in flight rather than racing two reconciliations over one cache.
   * ponytail: coalescing, not queueing — a resync arriving mid-run reuses that
   * run's inventory. Queue a trailing pass if that staleness ever bites.
   */
  discover(): Promise<void> {
    this.inFlight ??= this.runDiscovery().finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
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
      return
    }

    this.reconcile(devices)
    this.startEvents()
  }

  private async fetchInventory(): Promise<DiscoveredDevice[]> {
    const [cameras, lights, sensors, chimes, viewers] = await Promise.all([
      this.client.getCameras(),
      this.client.getLights(),
      this.client.getSensors(),
      this.client.getChimes(),
      this.client.getViewers(),
    ])
    this.log.info(`Discovered ${cameras.length} camera(s), ${lights.length} light(s), ${sensors.length} sensor(s), ${chimes.length} chime(s), ${viewers.length} viewer(s).`)
    return [...cameras, ...lights, ...sensors, ...chimes, ...viewers] as DiscoveredDevice[]
  }

  private reconcile(devices: DiscoveredDevice[]): void {
    const config = this.config!
    const wanted = new Map<string, DiscoveredDevice>()

    for (const device of devices) {
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
      // Bridged, always. Never publishExternalAccessories — a child bridge must
      // hold every camera under one pairing.
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      this.accessories.set(uuid, accessory)
      this.log.info(`Added ${device.modelKey} "${label}".`)
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
    // Frames missed while a socket was down are never replayed, so a reconnect
    // must be followed by a full REST discovery pass.
    this.events.on('resyncRequired', () => void this.discover())
    this.events.on('deviceUpdate', (frame: unknown) => this.applyDeviceUpdate(frame))
    this.events.start()
  }

  /** Frames arrive unvalidated. Nothing in here may throw back into the socket. */
  private applyDeviceUpdate(frame: unknown): void {
    const item = (frame as { item?: unknown })?.item
    const modelKey = (item as { modelKey?: unknown })?.modelKey
    if (typeof modelKey !== 'string')
      return

    const schema = deviceSchemas[modelKey]
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
