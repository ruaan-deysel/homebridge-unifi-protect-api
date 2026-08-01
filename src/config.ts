import { readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { PLATFORM_NAME } from './settings.js'

export const qualitySchema = z.enum(['high', 'medium', 'low'])

const deviceSettingsSchema = z.object({
  expose: z.boolean().optional(),
  quality: qualitySchema.optional(),
  hksv: z.boolean().optional(),
  smartDetect: z.array(z.string()).optional(),
  talkback: z.boolean().optional(),
})

const defaultsSchema = z.object({
  exposeNewDevices: z.boolean().default(true),
  quality: qualitySchema.default('high'),
  // Apple's 200GB iCloud plan supports exactly ONE HKSV camera. Defaulting this
  // to true makes HomeKit silently refuse to record every camera after the first.
  hksv: z.boolean().default(false),
}).default({ exposeNewDevices: true, quality: 'high', hksv: false })

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
  /** Keyed by Protect device id, NEVER by name, so renames preserve settings. */
  devices: z.record(z.string(), deviceSettingsSchema).default({}),
})

export type ProtectPluginConfig = z.infer<typeof configSchema>
export type DeviceSettings = z.infer<typeof deviceSettingsSchema>

export interface ResolvedDeviceSettings {
  expose: boolean
  quality: z.infer<typeof qualitySchema>
  hksv: boolean
  smartDetect: string[]
  talkback: boolean
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
    hksv: override?.hksv ?? config.defaults.hksv,
    smartDetect: override?.smartDetect ?? [],
    talkback: override?.talkback ?? false,
  }
}
