import { readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { PLATFORM_NAME } from './settings.js'

/**
 * `auto` picks the substream from HomeKit's own resolution request (see
 * `selectQuality`), which is right for almost everyone — the named values pin a
 * substream instead.
 */
export const qualitySchema = z.enum(['auto', 'high', 'medium', 'low'])

const deviceSettingsSchema = z.object({
  expose: z.boolean().optional(),
  quality: qualitySchema.optional(),
  // Off unless asked for. Australian surveillance-devices law treats audio far
  // more strictly than video and varies by state; outdoor cameras capture people
  // who have not consented. Same reasoning as hksv defaulting off.
  audio: z.boolean().optional(),
  hksv: z.boolean().optional(),
  smartDetect: z.array(z.string()).optional(),
  talkback: z.boolean().optional(),
  /**
   * The Doorbell's downward package lens, as its own accessory. Off by default:
   * it is a second accessory for one physical device, and the console serves it
   * at 2 fps, so it should appear only when someone asks for it.
   */
  packageCamera: z.boolean().optional(),
})

const defaultsSchema = z.object({
  exposeNewDevices: z.boolean().default(true),
  quality: qualitySchema.default('auto'),
  // Apple caps HKSV by camera COUNT, not storage: 50GB=1, 200GB=5, 2TB+=unlimited.
  // Footage does not count against the iCloud quota. Defaulting this
  // to true makes HomeKit silently refuse to record every camera after the first.
  hksv: z.boolean().default(false),
  /**
   * Apple caps HKSV by camera COUNT, not storage: 50GB=1, 200GB=5, 2TB+=unlimited,
   * and footage never counts against the quota. The plugin cannot see the
   * subscription, so this is the user telling us — used only to warn before they
   * enable recording on more cameras than the tier allows.
   */
  icloudTier: z.enum(['50gb', '200gb', '2tb']).default('200gb'),
}).default({ exposeNewDevices: true, quality: 'auto', hksv: false, icloudTier: '200gb' })

export const configSchema = z.object({
  platform: z.string(),
  name: z.string().default('UniFi Protect'),
  host: z.string({ error: 'host is required — the IP or hostname of your UniFi console' })
    .min(1, 'host is required — the IP or hostname of your UniFi console'),
  apiKey: z.string({ error: 'apiKey is required — create one in UniFi Site Manager → Integrations' })
    .min(1, 'apiKey is required — create one in UniFi Site Manager → Integrations'),
  defaults: defaultsSchema,
  /**
   * PEM of the console certificate this install trusts, written on first
   * connection and pinned on every later one. NOT shipped with the plugin and
   * never committed: it is this user's own hardware identity, and UniFi
   * regenerates it — a bundled PEM would rot and lock everyone out.
   */
  consoleCert: z.string().optional(),
  /**
   * Concurrent live views for the WHOLE host, not per camera. Left unset the
   * plugin picks from the encoder it found: six on hardware, two on software.
   */
  maxStreams: z.number().int().min(1).max(16).optional(),
  /** Overrides the ffmpeg search when the usable binary is somewhere unusual. */
  ffmpegPath: z.string().optional(),
  /** Keyed by Protect device id, NEVER by name, so renames preserve settings. */
  devices: z.record(z.string(), deviceSettingsSchema).default({}),
  /**
   * Slim device metadata cached from the last successful `/discover` run.
   * Written by the UI after Test Connection succeeds so the settings page can
   * show the device list on every subsequent load without a network round-trip.
   * Never read by the plugin itself — discovery is always fully dynamic.
   */
  discoveredDevices: z.array(z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    hasSpeaker: z.boolean(),
    hasMic: z.boolean(),
    hasLedStatus: z.boolean(),
    hasPackageCamera: z.boolean(),
    smartDetectTypes: z.array(z.string()),
  })).optional(),
})

export type ProtectPluginConfig = z.infer<typeof configSchema>
export type DeviceSettings = z.infer<typeof deviceSettingsSchema>

export interface ResolvedDeviceSettings {
  expose: boolean
  quality: z.infer<typeof qualitySchema>
  audio: boolean
  hksv: boolean
  smartDetect: string[]
  talkback: boolean
  packageCamera: boolean
}

export function parseConfig(raw: unknown) {
  return configSchema.safeParse(raw)
}

/**
 * Persists the trusted certificate into config.json.
 *
 * Homebridge gives plugins no API for writing their own config, so the file is
 * edited in place — the same thing every plugin that has to remember something
 * does. Only the one key is touched; the rest of the block (including the
 * child bridge's `_bridge` credentials) is left exactly as found.
 */
export function storeConsoleCert(configPath: string, host: string, pem: string): void {
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { platforms?: Record<string, unknown>[] }
  const blocks = Array.isArray(raw.platforms) ? raw.platforms : []
  const ours = blocks.filter(block => block?.platform === PLATFORM_NAME)
  // Host-matched first: `singular: true` makes more than one block unusual, but
  // writing the certificate into the wrong console's block would be worse than
  // not writing it at all.
  const block = ours.find(candidate => candidate.host === host) ?? (ours.length === 1 ? ours[0] : undefined)
  if (!block)
    throw new Error(`no ${PLATFORM_NAME} platform block for ${host} in ${configPath}`)
  block.consoleCert = pem
  // 4 spaces — what Homebridge itself writes, so this does not reformat the file.
  writeFileSync(configPath, `${JSON.stringify(raw, null, 4)}\n`)
}

/** Device overrides layered over the global defaults. */
export function settingsFor(config: ProtectPluginConfig, deviceId: string): ResolvedDeviceSettings {
  const override = config.devices[deviceId]
  return {
    expose: override?.expose ?? config.defaults.exposeNewDevices,
    quality: override?.quality ?? config.defaults.quality,
    // No global default: audio is opt-in per camera, deliberately. See the
    // schema comment — one console-wide switch is exactly the wrong shape for a
    // setting whose legality depends on where the individual camera points.
    audio: override?.audio ?? false,
    hksv: override?.hksv ?? config.defaults.hksv,
    smartDetect: override?.smartDetect ?? [],
    talkback: override?.talkback ?? false,
    // No global default, same reasoning as audio: opt-in per camera, since it
    // creates a second accessory and the console serves it at 2 fps.
    packageCamera: override?.packageCamera ?? false,
  }
}
