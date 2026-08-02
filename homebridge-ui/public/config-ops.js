// Pure configuration transforms. No DOM, no network — unit tested directly.

// Must track `defaultsSchema` in src/config.ts: `ensureConfig` writes these into
// config.json on every UI save, so a stale value here silently overrides the
// plugin's own default for every user who touches the settings page.
export const DEFAULTS = { exposeNewDevices: true, quality: 'auto', hksv: false, icloudTier: '200gb' }

/** Cameras each iCloud tier permits to record. Apple caps by COUNT, not storage. */
export const RECORDING_LIMITS = { '50gb': 1, '200gb': 5, '2tb': Number.POSITIVE_INFINITY }

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
    defaults: { ...DEFAULTS, ...(config.defaults ?? {}), icloudTier: parseIcloudTier(config.defaults?.icloudTier) },
    devices: { ...(config.devices ?? {}) },
  }
}

/**
 * Falls back to the default tier for anything `RECORDING_LIMITS` does not
 * recognise. Mirrors `parseMaxStreams`: without this, a hand-edited
 * `"1tb"` in config.json would be merged unvalidated by `ensureConfig`,
 * written straight back on the next save, and then fail `parseConfig` at
 * the next plugin start — the exact "UI wrote a value it can't load back"
 * failure `parseMaxStreams` already exists to prevent.
 */
export function parseIcloudTier(raw) {
  return Object.hasOwn(RECORDING_LIMITS, raw) ? raw : DEFAULTS.icloudTier
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

/**
 * Per-device defaults, derived from the global defaults. Exported because
 * index.html needs the same answer when it renders a checkbox unchecked; a
 * second copy of this table there would drift and write overrides that equal
 * the default.
 */
export function defaultFor(config, key) {
  if (key === 'expose')
    return config.defaults.exposeNewDevices
  if (key === 'quality')
    return config.defaults.quality
  if (key === 'hksv')
    return config.defaults.hksv
  if (key === 'icloudTier')
    return config.defaults.icloudTier
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
  typeEl.className = 'text-body-secondary small'
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
 * Says "restart" for the same reason AUDIO_LABEL does: HAP fixes the advertised
 * codecs and two-way capability when the controller is configured, and
 * `CameraController.streamingOptions` is private and read-only afterwards.
 */
export const TALKBACK_LABEL = 'Two-way audio (restart to enable)'

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
 * Only cameras, and only where `hasPackageCamera` is `true` on the device
 * itself — a TOP-LEVEL field on the discover payload (not under
 * `featureFlags`), read straight off what the console already sent. No probe:
 * nothing here makes a request to learn whether the lens exists.
 */
export function shouldOfferPackageCamera(device) {
  return device.type === 'camera' && device.hasPackageCamera === true
}

/**
 * Which per-device checkboxes a camera gets, in render order — index.html
 * renders exactly this list and nothing else, so the package toggle's
 * appearance is decided in tested code rather than in an untestable inline
 * branch. `comingLater` renders the control inert: the setting exists in the
 * schema but nothing reads it yet — which is now hksv alone. Audio, talkback
 * and the package lens are all live; do not add the flag back to them.
 *
 * `section` names the detail-pane section (see `renderDetail`'s `SECTIONS`
 * in ui-render.js) index.html files the toggle under. It lives here, next
 * to the decision of which toggles a device gets, rather than in index.html's
 * untested inline script — same file, same test seam.
 */
export function cameraToggles(device) {
  const toggles = []
  if (device.hasMic)
    toggles.push({ key: 'audio', label: AUDIO_LABEL, section: 'Live view' })
  toggles.push({ key: 'hksv', label: 'HomeKit Secure Video', comingLater: true, section: 'Recording' })
  if (device.hasSpeaker)
    toggles.push({ key: 'talkback', label: TALKBACK_LABEL, section: 'Live view' })
  if (shouldOfferPackageCamera(device))
    toggles.push({ key: 'packageCamera', label: PACKAGE_LABEL, section: 'Extra accessories' })
  return toggles
}

/**
 * The checkbox every per-device toggle is built from, this one included. Lives
 * here rather than inline in index.html so the injection guard can reach it:
 * `id` embeds `device.id` and the label can carry console-supplied text, both
 * attacker-controlled, and both land as property assignments — never markup.
 * The caller owns `checked`, `disabled` and the change listener.
 *
 * `needsRestart` renders an actual marker element (never baked into `label`
 * text), so the signal survives even for a control whose label does not
 * mention "restart" — pass `NEEDS_RESTART.has(key)`, not a guess.
 */
export function renderToggle(doc, id, label, needsRestart = false) {
  const wrap = doc.createElement('label')
  wrap.setAttribute('for', id)
  const input = doc.createElement('input')
  input.type = 'checkbox'
  input.id = id
  wrap.append(input, ` ${label}`)
  if (needsRestart) {
    const marker = doc.createElement('span')
    marker.className = 'badge text-bg-warning ms-2'
    marker.textContent = 'restart required'
    wrap.append(marker)
  }
  return { wrap, input }
}

/**
 * Homebridge offers a restart whenever config.json changes, so writing on every
 * click made that banner appear for settings that take effect immediately.
 * Each control still writes on change — losing an edit to a stray navigation
 * would be worse — but the disk write collapses.
 */
export function debounce(fn, ms) {
  let timer
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(fn, ms, ...args)
  }
}

export const SAVE_DEBOUNCE_MS = 1000

/**
 * HAP fixes a camera's advertised codecs, two-way capability and recording
 * options when the controller is configured, and `CameraController.streamingOptions`
 * is private and read-only afterwards — so turning any of these ON needs a
 * restart before it reaches HomeKit. Turning one OFF applies to the next
 * session. `renderToggle`'s marker is driven off this set rather than off
 * label text, so the signal is honest even for a toggle (like `hksv`) whose
 * label does not spell out "restart" itself.
 */
export const NEEDS_RESTART = new Set(['audio', 'talkback', 'hksv'])

/**
 * Accessories that would record, not cameras — the package lens is a SEPARATE
 * HomeKit accessory, so a doorbell with both recording and the package camera
 * on consumes two of the tier's slots.
 *
 * Takes the discovered device list, not just `config.devices`: a device with
 * no override entry still inherits `defaults.hksv`, and counting only the
 * entries that happen to exist in config.json would miss every camera
 * relying on the default (e.g. a user who flips `defaults.hksv` on). The
 * device list is also the only place `hasPackageCamera` lives — config.json
 * can carry a stale `packageCamera: true` left over from a lens that is no
 * longer there, and that would not create a second accessory.
 */
export function recordingCount(config, devices) {
  let count = 0
  for (const device of devices) {
    const settings = config.devices?.[device.id]
    if (!(settings?.hksv ?? defaultFor(config, 'hksv')))
      continue
    const packageCamera = (settings?.packageCamera ?? false) && device.hasPackageCamera
    count += packageCamera ? 2 : 1
  }
  return count
}

/**
 * Advisory, never enforcement: the plugin cannot see the user's iCloud
 * subscription, and refusing a setting on a guess would be worse than a
 * warning the user can ignore. Apple caps HKSV by camera COUNT, not
 * storage — footage never touches the quota.
 */
export function tierWarning(config, devices) {
  const tier = config.defaults?.icloudTier ?? DEFAULTS.icloudTier
  const limit = RECORDING_LIMITS[tier]
  const count = recordingCount(config, devices)
  if (count <= limit)
    return undefined
  return `${count} accessories are set to record, but your iCloud+ plan supports ${limit} on the ${tier} tier. HomeKit will refuse the extras — this is a heads-up, not a block.`
}

/**
 * True only when this device carries its OWN value for the key — the flat UI
 * showed just the resolved value, with no way to tell whether it came from
 * the global default or a per-device override.
 */
export function isOverridden(config, deviceId, key) {
  return config.devices?.[deviceId]?.[key] !== undefined
}

/**
 * Drops one override. An emptied device entry is removed rather than left as
 * `{}`, so config.json does not accumulate husks for devices that are back on
 * the defaults — the same rule `setDeviceSetting` already applies when a
 * value is set back to the default.
 */
export function clearDeviceSetting(config, deviceId, key) {
  const current = config.devices?.[deviceId]
  if (!current || current[key] === undefined)
    return config
  const { [key]: _dropped, ...rest } = current
  const devices = { ...config.devices }
  if (Object.keys(rest).length === 0)
    delete devices[deviceId]
  else
    devices[deviceId] = rest
  return { ...config, devices }
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
