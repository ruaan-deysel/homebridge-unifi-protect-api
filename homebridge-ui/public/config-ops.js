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
  // Both default off with no global override, exactly as `settingsFor` resolves
  // them in src/config.ts — audio deliberately has no console-wide default,
  // since whether recording it is legal depends on where each camera points.
  if (key === 'talkback' || key === 'audio')
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
 * The live-view quality choices, `[value, label]`. Every value MUST be one the
 * `qualitySchema` enum in src/config.ts accepts — a value only this file knows
 * about would be written to config.json on save and then refuse to load, and
 * Zod does not re-validate defaults, so nothing else would notice. There is a
 * test pinning these against the real schema.
 *
 * The resolutions are the substreams measured on the live console, not marketing
 * numbers: someone choosing "low" deserves to know it is 640x360.
 */
export const QUALITY_OPTIONS = [
  ['auto', 'Auto — follow what HomeKit asks for'],
  ['high', 'High — 2688 × 1512'],
  ['medium', 'Medium — 1280 × 720'],
  ['low', 'Low — 640 × 360'],
]

/**
 * Builds the per-camera quality selector with DOM APIs only — never
 * `innerHTML`. `device.id` is console-supplied and therefore
 * attacker-controlled, exactly like the name in `renderDeviceHeader`, and it is
 * embedded in the `id`/`for` pair here. Extracted out of index.html for the same
 * reason that one was: so the XSS discipline has a unit test guarding it.
 *
 * Returns the label and the select separately; wiring the `change` listener is
 * the caller's job, which keeps this function pure DOM construction.
 */
export function renderQualitySelect(doc, device, value) {
  const id = `${device.id}-quality`
  const wrap = doc.createElement('label')
  wrap.setAttribute('for', id)
  wrap.append('Live view quality ')

  const select = doc.createElement('select')
  select.className = 'form-control'
  select.id = id
  for (const [optionValue, label] of QUALITY_OPTIONS) {
    const option = doc.createElement('option')
    option.value = optionValue
    option.textContent = label
    if (optionValue === value)
      option.selected = true
    select.append(option)
  }
  wrap.append(select)
  return { wrap, select }
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
