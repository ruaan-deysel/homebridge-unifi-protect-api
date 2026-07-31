// Pure configuration transforms. No DOM, no network — unit tested directly.

export const DEFAULTS = { exposeNewDevices: true, quality: 'high', hksv: false }

export function ensureConfig(raw) {
  const config = raw ?? {}
  return {
    platform: 'UniFiProtect',
    name: config.name ?? 'UniFi Protect',
    host: config.host ?? '',
    apiKey: config.apiKey ?? '',
    defaults: { ...DEFAULTS, ...(config.defaults ?? {}) },
    devices: { ...(config.devices ?? {}) },
  }
}

/** Per-device defaults, derived from the global defaults. */
function defaultFor(config, key) {
  if (key === 'expose')
    return config.defaults.exposeNewDevices
  if (key === 'quality')
    return config.defaults.quality
  if (key === 'hksv')
    return config.defaults.hksv
  if (key === 'smartDetect')
    return undefined
  if (key === 'talkback')
    return false
  return undefined
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Writes an override only when it differs from the effective default, so an
 * untouched device contributes nothing to config.json and changing a default
 * actually moves every untouched device.
 */
export function setDeviceSetting(config, deviceId, key, value) {
  const devices = { ...config.devices }
  const entry = { ...(devices[deviceId] ?? {}) }

  if (same(value, defaultFor(config, key)))
    delete entry[key]
  else
    entry[key] = value

  if (Object.keys(entry).length === 0)
    delete devices[deviceId]
  else
    devices[deviceId] = entry

  return { ...config, devices }
}
