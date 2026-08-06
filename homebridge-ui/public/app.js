// The settings page's behaviour. It used to live inline in index.html, where
// eslint resolved no config for it and no test could load it - and that is
// exactly how a detached `homebridge.toast` method shipped a settings page
// with no devices and a dead Test Connection button. Nothing here reaches for
// a global: `doc`, `homebridge` and `win` all arrive as arguments, so a test
// drives the whole page with fakes.
//
// index.html keeps the markup plus a two-line bootstrap that calls `startUi`
// with the real globals.

import { cameraToggles, clearDeviceSetting, debounce, defaultFor, ensureConfig, HKSV_LABEL, isOverridden, NEEDS_RESTART, parseIcloudTier, parseMaxStreams, renderQualitySelect, renderToggle, SAVE_DEBOUNCE_MS, setDeviceSetting, setDiscoveredDevices, setGlobalSetting, tierWarning } from './config-ops.js'
import { renderBadge, renderDetail, renderDeviceList, renderTabs } from './ui-render.js'

/**
 * Adds `id` to a control's accessible DESCRIPTION, once. Everything the page
 * appends beside a control rather than inside its `<label>` - the restart
 * marker, the default/overridden badge - stays out of the accessible NAME by
 * design, and would otherwise be announced to nobody: a screen-reader user
 * heard "Two-way audio" and was never told a restart was required, while
 * sighted users saw the badge. Idempotent, because the badge is rebuilt in
 * place on every change and keeps the same id.
 */
function describe(control, id) {
  const ids = (control.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
  if (!ids.includes(id))
    ids.push(id)
  control.setAttribute('aria-describedby', ids.join(' '))
}

/**
 * Wires the whole settings page.
 *
 * @param doc The document holding index.html's markup.
 * @param homebridge The plugin-ui-utils runtime the parent frame injects.
 * @param win Where `pagehide` is heard - the real window by default.
 */
export async function startUi(doc, homebridge, win = globalThis) {
  // Build the tab shell, then move each pane's static markup into the empty
  // pane element renderTabs created for it - the DOM nodes themselves are
  // relocated (appendChild moves, it does not clone), so every id below
  // still resolves exactly once.
  const { tablist, panes } = renderTabs(doc, ['Connection', 'Defaults', 'Devices', 'Help'])
  const [connectionPane, defaultsPane, devicesPane, helpPane] = panes
  const tabRoot = doc.getElementById('tab-root')
  tabRoot.before(tablist, ...panes)
  tabRoot.remove()
  connectionPane.append(doc.getElementById('connection-pane'))
  defaultsPane.append(doc.getElementById('defaults-pane'))
  devicesPane.append(doc.getElementById('devices-pane'))
  helpPane.append(doc.getElementById('help-pane'))

  const statusEl = doc.getElementById('status')
  const trustEl = doc.getElementById('trust')
  const deviceListEl = doc.getElementById('device-list')
  const deviceFilterEl = doc.getElementById('device-filter')
  const deviceDetailEl = doc.getElementById('device-detail')
  const hostEl = doc.getElementById('host')
  const keyEl = doc.getElementById('apiKey')

  let config = ensureConfig((await homebridge.getPluginConfig())[0])
  // What was last handed to `updatePluginConfig` successfully. Callers mutate
  // `config` BEFORE calling `save()`, so a rejected write has to put this back
  // - otherwise the page goes on showing a value that never reached disk.
  let savedConfig = config

  /**
   * Transient outcomes go to Homebridge's own toast, which is what a user
   * watching the page notices. The `aria-live` status line stays and carries
   * the SAME text: a toast disappears on a timer and is not something a screen
   * reader user can go back to, so removing the region would be a regression.
   * `error.message` is server-supplied text and lands as an argument, never
   * as markup.
   *
   * Declared up here because both halves of saving - the immediate
   * `updatePluginConfig` and the debounced config.json write - report their
   * failures through it.
   */
  const report = (text, ok) => {
    statusEl.textContent = text
    // Called as METHODS, deliberately. Selecting one with a ternary and calling
    // the result - `(ok ? toast.success : toast.error)(text)` - detaches it from
    // `homebridge.toast`, and plugin-ui-utils' implementation does
    // `this._postMessage(...)`, so every call threw
    // "Cannot read properties of undefined (reading '_postMessage')". `report`
    // is the shared status reporter and runs BEFORE discovery, so that one
    // throw took out Test Connection and the whole device list with it.
    if (ok)
      homebridge.toast.success(text)
    else
      homebridge.toast.error(text)
  }

  /** What the trust panel says while the pinned certificate is the current one. */
  const PINNED_NOTICE = 'This console\'s certificate is trusted and pinned. Press Test Connection to verify it still matches.'

  // Puts the whole Connection tab back on what `config` holds. It sets the
  // initial values AND is the `resync` the connection test hands `save()`, so
  // there is one expression of "what should this tab show" - a rejected write
  // rolls `config` back, and the typed host, the API key and a freshly pinned
  // certificate have to roll back on screen with it.
  const syncConnection = () => {
    hostEl.value = config.host
    keyEl.value = config.apiKey
    // renderTrust is a hoisted function declaration; this runs before its
    // source position deliberately, so the panel has one owner.
    renderTrust(config.consoleCert ? [{ text: PINNED_NOTICE }] : [])
  }
  syncConnection()

  // savePluginConfig() writes config.json, and Homebridge's own chrome then
  // offers a restart for every write - so a burst of clicks (or dragging a
  // slider) does not need one disk write per click. updatePluginConfig stays
  // synchronous with every change instead of being debounced too: it only
  // updates the in-memory config the UI runtime holds, and losing an edit to
  // a stray navigation before the debounce fires would be worse than an extra
  // write.
  //
  // The promise is NOT discarded: a rejected write used to become an unhandled
  // rejection inside the iframe while the page went on showing the new value,
  // so the UI agreed with the user and config.json never changed.
  const debouncedSavePluginConfig = debounce(() => {
    homebridge.savePluginConfig().catch((error) => {
      // `save()` returned `true` long before this ran - `updatePluginConfig`
      // only updates the runtime's in-memory copy, and THIS is the call that
      // writes config.json. There is nothing honest to roll back to (the
      // runtime is holding the new value, so restoring the controls would only
      // make screen and runtime disagree the other way), so the failure is
      // stated plainly instead: what is on screen is not what a reload shows.
      report(`Could not write config.json: ${error.message}. The settings on screen are not saved - reopen this page to see what is on disk.`, false)
    })
  }, SAVE_DEBOUNCE_MS)

  // The debounce window is a second wide, and closing the settings modal inside
  // it dropped the pending write silently. `flush()` is a no-op when nothing is
  // pending, so both handlers can fire unconditionally.
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden')
      debouncedSavePluginConfig.flush()
  })
  win.addEventListener('pagehide', () => debouncedSavePluginConfig.flush())

  // All discovered devices, kept around so the tier warning can count
  // recording accessories host-wide, not just the one currently shown.
  let allDevices = []
  // The banner currently in the detail pane, if the selected device is a
  // camera - `null` otherwise, so a stale/detached element from a previously
  // selected device is never updated by mistake.
  let tierWarningEl = null

  const updateTierWarning = () => {
    if (!tierWarningEl)
      return
    const message = tierWarning(config, allDevices)
    tierWarningEl.textContent = message ?? ''
    tierWarningEl.style.display = message ? '' : 'none'
  }

  /**
   * Persists `config`. A failed write must not be followed by a UI that
   * refreshes as though it succeeded: the in-memory config goes back to what
   * is on disk and `resync` puts the control that was just changed back with
   * it. Without that rollback the checkbox - and `config` itself - kept a
   * value `updatePluginConfig` had rejected, which is the opposite of the
   * "leave everything showing what is on disk" this comment used to claim.
   *
   * @param resync Restores the changed control from `config`. Callers reuse
   * the same closure that set the control's initial value, so there is only
   * ever one expression of "what should this control show".
   * @returns Whether the runtime ACCEPTED the change - a caller that reports
   * success has to ask. It is not a promise that config.json is on disk: that
   * write is debounced (see `debouncedSavePluginConfig`) and reports its own
   * failure, because it happens long after this has returned.
   */
  const save = async (resync) => {
    // Snapshotted BEFORE the await, and written back afterwards instead of
    // `config`: `config` is a shared binding another control can replace while
    // this write is in flight. Recording `savedConfig = config` on the way out
    // marked the NEWEST value as saved, so when that second, still-pending
    // write was then refused, the rollback restored the very value the runtime
    // had rejected - and the next unrelated save persisted it.
    const attempted = config
    let ok = true
    try {
      await homebridge.updatePluginConfig([attempted])
      savedConfig = attempted
      debouncedSavePluginConfig()
    }
    catch (error) {
      ok = false
      config = savedConfig
      resync?.()
      // Through `report`, not the toast alone: a toast is gone on a timer, and
      // a failed save is exactly the thing a screen-reader user needs left in
      // the aria-live region.
      report(`Could not save config.json: ${error.message}`, false)
    }
    // Any device's recording setting can push the tier count over the edge,
    // not just the one being edited - recompute whenever config changes, the
    // rollback included.
    updateTierWarning()
    return ok
  }

  const settingOf = (id, key, fallback) => config.devices[id]?.[key] ?? fallback

  // Host-wide settings. Populated from the saved config and written straight
  // back, so neither of them needs config.json to be edited by hand.
  const maxStreamsEl = doc.getElementById('maxStreams')
  const ffmpegPathEl = doc.getElementById('ffmpegPath')
  const syncMaxStreams = () => {
    maxStreamsEl.value = config.maxStreams ?? ''
  }
  const syncFfmpegPath = () => {
    ffmpegPathEl.value = config.ffmpegPath ?? ''
  }
  syncMaxStreams()
  syncFfmpegPath()

  maxStreamsEl.addEventListener('change', async () => {
    const value = parseMaxStreams(maxStreamsEl.value)
    config = setGlobalSetting(config, 'maxStreams', value)
    // Echo back what was actually stored: an out-of-range entry is dropped, and
    // leaving the rejected number sitting in the box would claim otherwise.
    // The same closure runs again if the write fails, against the restored
    // config.
    syncMaxStreams()
    await save(syncMaxStreams)
  })

  ffmpegPathEl.addEventListener('change', async () => {
    config = setGlobalSetting(config, 'ffmpegPath', ffmpegPathEl.value.trim())
    syncFfmpegPath()
    await save(syncFfmpegPath)
  })

  // The per-camera defaults every device inherits from. Without these the
  // default/overridden badges pointed at values only a hand-edited config.json
  // could change. Written into `config.defaults`, which is what `defaultFor`
  // reads, so flipping one here moves every device that has not overridden it.
  const setDefault = async (key, value, resync) => {
    config = { ...config, defaults: { ...config.defaults, [key]: value } }
    await save(resync)
  }

  const icloudTierEl = doc.getElementById('icloudTier')
  // Through parseIcloudTier so a hand-edited tier the schema does not know
  // shows the default the config was actually normalised to, not a blank box.
  const syncIcloudTier = () => {
    icloudTierEl.value = parseIcloudTier(config.defaults.icloudTier)
  }
  syncIcloudTier()
  // `save()` recomputes the tier warning, so changing the plan re-judges the
  // count immediately rather than at the next toggle.
  icloudTierEl.addEventListener('change', () => setDefault('icloudTier', icloudTierEl.value, syncIcloudTier))

  const defaultsControlsEl = doc.getElementById('defaults-controls')

  // Built with the same helpers the per-device controls use, so the switches,
  // the restart marker and the quality options cannot drift between the two
  // tabs. No badge: a default is what a badge would be measured against.
  const defaultToggle = (key, defaultsKey, label) => {
    const { wrap, input } = renderToggle(doc, `defaults-${defaultsKey}`, label, NEEDS_RESTART.has(key))
    const sync = () => {
      input.checked = Boolean(config.defaults[defaultsKey])
    }
    sync()
    input.addEventListener('change', () => setDefault(defaultsKey, input.checked, sync))
    defaultsControlsEl.append(wrap)
  }

  defaultToggle('expose', 'exposeNewDevices', 'Expose new devices in HomeKit')
  defaultToggle('hksv', 'hksv', HKSV_LABEL)

  {
    // `renderQualitySelect` keys its id off `device.id`; a literal stands in
    // for the device here, since this select is the host-wide default.
    const { wrap, select } = renderQualitySelect(doc, { id: 'defaults' }, config.defaults.quality)
    const sync = () => {
      select.value = config.defaults.quality
    }
    select.addEventListener('change', () => setDefault('quality', select.value, sync))
    defaultsControlsEl.append(wrap)
  }

  /**
   * Renders one device's settings into the detail pane. `mount` inserts the
   * pane and THEN moves focus to its heading - the list stays where it is, but
   * the content the user asked for just replaced what used to be there, so
   * focus has to follow it. That order is the whole point: focusing before
   * insertion is a no-op.
   */
  function showDetail(device) {
    const { bodies, mount } = renderDetail(doc, device)
    tierWarningEl = null

    // Appends a badge (default/overridden) plus, when overridden, a reset
    // button to `wrap` - and keeps it live across changes by tearing down
    // and rebuilding it rather than mutating in place, since `renderBadge`
    // owns both the label and whether a reset button exists at all.
    //
    // `wrap` is a container, never the control's own `<label>`: a badge
    // nested inside the label folded into the checkbox's accessible name
    // ("… restart required overridden reset") and a nested button is invalid
    // HTML besides. renderToggle returns the container.
    // `resync` is the caller's "put this control on the value `config` says",
    // the same closure that set its initial value: clearing the override makes
    // that the default, and a failed write makes it the override again.
    // `control` is the input/select the badge describes. Unnesting the badge
    // took it out of the accessible NAME, which is right - and left it
    // announced to nobody, which is not. `aria-describedby` puts it back in the
    // accessible DESCRIPTION: the id is derived from the control's, so the
    // rebuild below reuses it and the list never points at a removed node.
    const attachBadge = (control, wrap, key, resync, label) => {
      let current
      const refresh = () => {
        current?.badge.remove()
        current?.reset?.remove()
        current = renderBadge(doc, isOverridden(config, device.id, key), async () => {
          config = clearDeviceSetting(config, device.id, key)
          resync()
          await save(resync)
          refresh()
        }, label)
        current.badge.id = `${control.id}-state`
        wrap.append(current.badge)
        if (current.reset)
          wrap.append(current.reset)
        describe(control, current.badge.id)
      }
      refresh()
      return refresh
    }

    const toggle = (body, key, label) => {
      // id embeds device.id (console-supplied) - renderToggle builds it with
      // DOM APIs only, and carries the injection test for this path.
      const { wrap, input } = renderToggle(doc, `${device.id}-${key}`, label, NEEDS_RESTART.has(key))
      const sync = () => {
        input.checked = Boolean(settingOf(device.id, key, defaultFor(config, key)))
      }
      sync()
      // Defaults vs overrides were otherwise invisible - the flat UI only
      // ever showed the resolved value. `refreshBadge` re-reads
      // `isOverridden` after every change, so the badge and the checkbox
      // never disagree.
      const refreshBadge = attachBadge(input, wrap, key, sync, label)
      input.addEventListener('change', async () => {
        config = setDeviceSetting(config, device.id, key, input.checked)
        await save(sync)
        refreshBadge()
      })
      body.append(wrap)
    }

    toggle(bodies.General, 'expose', 'Expose in HomeKit')

    // Capability-driven: a control is only offered when the hardware can
    // honour it, so the UI never lets someone flip a setting that will
    // silently do nothing.
    if (device.type === 'camera') {
      const { wrap, select } = renderQualitySelect(doc, device, settingOf(device.id, 'quality', defaultFor(config, 'quality')))
      const syncQuality = () => {
        select.value = settingOf(device.id, 'quality', defaultFor(config, 'quality'))
      }
      const refreshQualityBadge = attachBadge(select, wrap, 'quality', syncQuality, 'Live view quality')
      select.addEventListener('change', async () => {
        config = setDeviceSetting(config, device.id, 'quality', select.value)
        await save(syncQuality)
        refreshQualityBadge()
      })
      bodies['Live view'].append(wrap)

      // Advisory only (see tierWarning) - shown beside the recording toggle
      // it is about, not buried in Help, since this is where the decision to
      // turn recording on actually gets made.
      tierWarningEl = doc.createElement('div')
      tierWarningEl.className = 'alert alert-warning small mb-2'
      tierWarningEl.setAttribute('role', 'status')
      bodies.Recording.append(tierWarningEl)
      updateTierWarning()

      // Which checkboxes a camera gets, and which section each files under
      // - including whether the package lens is offered - is decided in
      // config-ops.js, where a test can reach it.
      for (const { key, label, section } of cameraToggles(device))
        toggle(bodies[section ?? 'Live view'], key, label)
    }

    mount(deviceDetailEl)
  }

  function render(devices) {
    allDevices = devices
    // A rediscovery rebuilds the list, so the pane beside it can be showing a
    // device that is no longer in it - and `tierWarningEl` would still be the
    // detached banner from that pane. Both go back to the empty state.
    deviceDetailEl.textContent = 'Select a device from the list.'
    tierWarningEl = null
    const { list, filter } = renderDeviceList(doc, devices, (id) => {
      const device = devices.find(d => d.id === id)
      if (device)
        showDetail(device)
    })
    deviceListEl.replaceChildren(list)
    deviceFilterEl.value = ''
    deviceFilterEl.oninput = () => filter(deviceFilterEl.value)
    updateTierWarning()
  }

  // If a previous Test Connection cached the device list, render it immediately
  // so the user sees the devices without pressing Test Connection again.
  if (Array.isArray(config.discoveredDevices) && config.discoveredDevices.length > 0)
    render(config.discoveredDevices)

  /**
   * Every line here is built with DOM APIs and lands as `textContent`.
   * Fingerprints and hostnames come from whatever answered on the network -
   * treat them as attacker-controlled and NEVER interpolate them into markup.
   */
  function renderTrust(lines, { warn = false, retrust = null } = {}) {
    trustEl.replaceChildren()
    if (lines.length === 0)
      return
    const card = doc.createElement('div')
    card.className = warn ? 'card card-body mb-2 border-danger' : 'card card-body mb-2 text-body-secondary small'
    for (const line of lines) {
      const p = doc.createElement('div')
      if (line.fingerprint)
        p.className = 'font-monospace small text-break'
      p.textContent = line.text
      card.append(p)
    }
    if (retrust) {
      const button = doc.createElement('button')
      button.className = 'btn btn-danger'
      button.type = 'button'
      button.textContent = 'Trust this certificate'
      // Deliberate, explicit, one click that the user has to find and press -
      // the plugin itself never re-trusts on its own.
      button.addEventListener('click', async () => {
        config = { ...config, consoleCert: retrust }
        // Only claim the certificate is trusted if the write that stores it
        // actually landed - `save()` rolls `config` back otherwise, and a
        // "now trusted" message over a config that no longer holds the
        // certificate is the same lie the toggles used to tell.
        if (await save())
          renderTrust([{ text: 'The new certificate is now trusted. Restart Homebridge, then press Test Connection.' }])
      })
      card.append(button)
    }
    trustEl.append(card)
  }

  const testEl = doc.getElementById('test')

  /**
   * Extracted from the click handler so the whole thing - every early return
   * included - can sit inside one re-entrancy guard below.
   */
  const runConnectionTest = async () => {
    statusEl.textContent = 'Checking the console\'s certificate…'
    // The key is only ever sent to the local server-side handler over the
    // homebridge IPC channel - never logged, never echoed back into the DOM.
    config = { ...config, host: hostEl.value.trim(), apiKey: keyEl.value.trim() }

    // Certificate first, credential second: nothing below sends the API key
    // until the certificate on the wire is the one this install trusts.
    let cert
    try {
      cert = await homebridge.request('/console-cert', { host: config.host, consoleCert: config.consoleCert })
    }
    catch (error) {
      report(error.message, false)
      return
    }

    if (cert.matches === false) {
      report('Refused to connect - the console\'s certificate changed. The API key was not sent.', false)
      renderTrust([
        { text: `The certificate presented by ${config.host} does not match the one this plugin trusts, so the connection was refused before the API key was sent.` },
        { text: `Trusted: ${cert.trustedFingerprint}`, fingerprint: true },
        { text: `Presented: ${cert.fingerprint}`, fingerprint: true },
        { text: 'If you know why it changed - the console was reinstalled, reset, or its certificate regenerated - trust the new one below. If you do not, treat this as an interception attempt and do not trust it.' },
      ], { warn: true, retrust: cert.pem })
      return
    }

    if (cert.matches === null) {
      config = { ...config, consoleCert: cert.pem }
      renderTrust([
        { text: `Now trusting this console's certificate. Compare it with the fingerprint your console shows if you want to be certain - every later connection is pinned to it.` },
        { text: `SHA-256: ${cert.fingerprint}`, fingerprint: true },
      ])
    }

    statusEl.textContent = 'Connecting…'
    const credentials = { host: config.host, apiKey: config.apiKey, consoleCert: config.consoleCert }
    try {
      const info = await homebridge.request('/test-connection', credentials)
      // Store BEFORE claiming success. A refused write rolls `config` back -
      // taking the typed host, the API key and any certificate just pinned
      // above with it - so a "Connected" toast, a trust panel still saying
      // "every later connection is pinned to it", and a discovery run against
      // credentials the page no longer holds would all be lies. `save()`
      // reports the failure itself.
      if (!await save(syncConnection))
        return
      report(`Connected — ${info.nvrName}, Protect ${info.version}`, true)
      const { devices } = await homebridge.request('/discover', credentials)
      render(devices)
      // Persist the discovered devices so the next page load can restore the
      // list without a network request. A failed write rolls `config` back but
      // does not undo the render for the current session - the list is already
      // showing and will stay until the page is reloaded.
      config = setDiscoveredDevices(config, devices)
      await save(syncConnection)
    }
    catch (error) {
      report(error.message, false)
    }
  }

  /**
   * One check at a time. Reading an unreachable console's certificate takes
   * until the TCP timeout - measured at ~18s against 10.255.255.1 - and the
   * button stayed live for all of it, so repeated clicks fired CONCURRENT
   * certificate reads whose completions raced to write the same `config`
   * object and the same aria-live status line. Disabling for the duration is
   * the whole fix; the error path itself was already correct and does time out.
   *
   * `finally`, so a throw anywhere in the body still gives the button back -
   * a permanently dead Test Connection would be worse than the race.
   */
  testEl.addEventListener('click', async () => {
    if (testEl.disabled)
      return
    testEl.disabled = true
    try {
      await runConnectionTest()
    }
    finally {
      testEl.disabled = false
    }
  })
}
