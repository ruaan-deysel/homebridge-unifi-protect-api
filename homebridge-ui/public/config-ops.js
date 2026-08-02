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

/**
 * The host-wide stream cap's accepted range. MUST match `maxStreams` in
 * src/config.ts: a value only this file allows would be written to config.json
 * on save and then refuse to load, leaving the plugin dead with a validation
 * error the user never saw while typing it. There is a test pinning these
 * against the real schema.
 */
export const MAX_STREAMS_RANGE = { min: 1, max: 16 }

/**
 * The stream cap as the schema wants it, or `undefined` for "let the plugin
 * decide". Anything out of range — including the empty field, which is how a
 * user clears it — becomes `undefined` rather than being stored: `maxStreams`
 * is optional, and an empty string or a NaN written into config.json would fail
 * `parseConfig` on the next start.
 */
export function parseMaxStreams(raw) {
  const value = Number(String(raw).trim())
  if (!Number.isInteger(value) || value < MAX_STREAMS_RANGE.min || value > MAX_STREAMS_RANGE.max)
    return undefined
  return value
}

/**
 * Writes a top-level optional setting, or removes it when the value is absent.
 * Removing matters: both `maxStreams` and `ffmpegPath` are optional, and storing
 * `""` for the path would send `probeFfmpeg` after a binary at the empty path
 * instead of letting it search.
 */
export function setGlobalSetting(config, key, value) {
  const next = { ...config }
  if (value === undefined || value === '')
    delete next[key]
  else
    next[key] = value
  return next
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
  if (key === 'talkback' || key === 'audio' || key === 'packageCamera')
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
 * The audio toggle's label. It names the restart deliberately: HAP tells HomeKit
 * which audio codecs a camera offers when the controller is attached at startup
 * and gives no way to change it afterwards, so switching audio ON only reaches
 * HomeKit after a restart — the one Homebridge already prompts for on save.
 * Switching it OFF applies to the next live view immediately. A toggle that
 * silently did nothing until a restart would look broken.
 */
export const AUDIO_LABEL = 'Live view audio (restart to enable)'

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
 * The package-toggle label. It names the frame rate deliberately: enabling this
 * creates a second accessory for one physical device, and the console serves
 * that lens at 2 fps — someone who enables it expecting normal video should be
 * told first, not surprised after the fact.
 */
export const PACKAGE_LABEL = 'Package camera (separate accessory, 2 fps)'

/**
 * Only cameras, and only where the probe (see src/protect/stream.ts,
 * `hasPackageCamera`) found the lens — a real Doorbell's `featureFlags` has no
 * such field, so this must come from the discover payload's probed result, not
 * from guessing at every camera.
 */
export function shouldOfferPackageCamera(device) {
  return device.type === 'camera' && device.hasPackageCamera === true
}

/**
 * Built with DOM APIs only — never `innerHTML`. `device.id` is console-supplied
 * and therefore attacker-controlled, exactly like the ids in
 * `renderQualitySelect`; it lands in the `id`/`for` pair as a property
 * assignment, never as markup.
 */
export function renderPackageToggle(doc, device, checked) {
  const wrap = doc.createElement('div')
  const input = doc.createElement('input')
  input.type = 'checkbox'
  input.id = `package-${device.id}`
  input.checked = checked === true
  const label = doc.createElement('label')
  label.htmlFor = input.id
  label.textContent = PACKAGE_LABEL
  wrap.append(input, label)
  return wrap
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
