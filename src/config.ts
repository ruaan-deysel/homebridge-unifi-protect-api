import { z } from 'zod'

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
