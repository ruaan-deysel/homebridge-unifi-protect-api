// Pure configuration transforms. No DOM, no network — unit tested directly.

// Must track `defaultsSchema` in src/config.ts: `ensureConfig` writes these into
// config.json on every UI save, so a stale value here silently overrides the
// plugin's own default for every user who touches the settings page.
export const DEFAULTS = { exposeNewDevices: true, quality: 'auto', hksv: false }

/**
 * Normalises the platform block WITHOUT dropping anything it does not know
 * about. `updatePluginConfig` replaces the whole block ("Existing blocks not
 * included will be removed"), and Homebridge stores the child bridge's
 * username, port and PIN under `_bridge` right here. Rebuilding from a
 * whitelist unpaired the bridge on every save — re-pairing every accessory and
 * losing rooms, scenes and automations. So: spread first, normalise over it.
 */
export function ensureConfig(raw) {
  const config = raw ?? {}
  return {
    ...config,
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
 * Builds the device card header from DOM APIs only — never `innerHTML`.
 * `device.name`/`device.type` come from the Protect console and are
 * attacker-controlled (anyone who can rename a camera in the Protect app),
 * so they must land as `textContent`, never be parsed as markup. Extracted
 * here (rather than left inline in index.html) so it has a DOM-free unit
 * test guarding against this regressing back to a template literal. `doc`
 * is injected so the test can supply a minimal fake without a real DOM.
 */
export function renderDeviceHeader(doc, device) {
  const nameEl = doc.createElement('strong')
  nameEl.textContent = device.name ?? ''
  const typeEl = doc.createElement('span')
  typeEl.className = 'up-muted'
  typeEl.textContent = device.type ?? ''
  return [nameEl, ' ', typeEl]
}

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
