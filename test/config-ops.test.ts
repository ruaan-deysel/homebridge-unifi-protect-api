import type { DeviceOverride, IcloudTier } from '../homebridge-ui/public/config-ops.js'
import { describe, expect, it, vi } from 'vitest'
import { AUDIO_LABEL, cameraToggles, clearDeviceSetting, debounce, defaultFor, DEFAULTS, ensureConfig, isOverridden, MAX_STREAMS_RANGE, NEEDS_RESTART, PACKAGE_LABEL, parseIcloudTier, parseMaxStreams, QUALITY_OPTIONS, RECORDING_LIMITS, recordingCount, renderDeviceHeader, renderQualitySelect, renderToggle, SAVE_DEBOUNCE_MS, setDeviceSetting, setGlobalSetting, shouldOfferPackageCamera, TALKBACK_LABEL, tierWarning } from '../homebridge-ui/public/config-ops.js'
import { parseConfig, settingsFor } from '../src/config.js'

// Minimal fake DOM — just enough to prove renderDeviceHeader never turns
// console-supplied text into markup. The load-bearing assertion is the
// `textContent` one: it holds only if the payload was assigned via textContent,
// and fails against an `innerHTML`/template-literal implementation, which would
// have parsed the string into child elements and left `_text` empty (see the
// `innerHTML` setter below). No jsdom dependency needed for the one property
// under test.
//
// An earlier version of these XSS-regression tests also asserted
// `findByTag(..., 'IMG')` to be null/undefined. That assertion could never
// fail: FakeElement's `innerHTML` setter stores the string and clears
// `children` — it never parses markup into child elements — so no mutation
// of the renderer under test could ever make `findByTag` find an IMG. It has
// been removed everywhere it was copied (this file and
// test/ui-render.test.ts); the `textContent`/`outerHTML` assertions beside
// each removal are the real guard and are proven to fail under mutation (see
// the fix-wave report).
export class FakeElement {
  tagName: string
  children: (FakeElement | string)[] = []
  attributes: Record<string, string> = {}
  /** Properties, not markup — assigning these can never parse a payload. */
  id = ''
  value = ''
  selected = false
  type = ''
  checked = false
  /** Only the one CSS property ui-render.js touches. */
  style: { display: string } = { display: '' }
  /** Mirrors the real DOM's `dataset` — a property bag, never markup. */
  dataset: Record<string, string> = {}
  tabIndex = 0
  private listeners = new Map<string, ((event: Record<string, unknown>) => void)[]>()
  private _text = ''
  private _html?: string

  addEventListener(type: string, handler: (event: Record<string, unknown>) => void) {
    const forType = this.listeners.get(type) ?? []
    forType.push(handler)
    this.listeners.set(type, forType)
  }

  /** Fires a synthetic event at every listener registered for `type`. */
  dispatch(type: string, event: Record<string, unknown> = {}) {
    for (const handler of this.listeners.get(type) ?? [])
      handler(event)
  }

  /**
   * Real focus has no visual effect in this harness, but the call itself is
   * load-bearing: U3 (selection moves focus to the detail heading) is proven
   * by counting calls here, not by reading source.
   */
  focusCount = 0
  focus() { this.focusCount++ }

  /**
   * Markup, and treated as markup: `outerHTML` emits it RAW and `textContent`
   * stops returning the assigned string. That is what makes a renderer rewritten
   * to `innerHTML` with an interpolated payload genuinely fail the tests below —
   * without this setter the assignment would land as an inert own property that
   * `outerHTML` never reads, and the guard would pass over a real hole.
   */
  set innerHTML(value: string) {
    this._html = value
    this._text = ''
    this.children = []
  }

  get innerHTML(): string {
    return this._html ?? ''
  }

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase()
  }

  set textContent(value: string) {
    this._text = value
    this.children = []
  }

  get textContent(): string {
    // Markup assigned via innerHTML is NOT text — a real DOM would have parsed
    // it into elements, so the raw string can never come back out here.
    if (this._html !== undefined)
      return ''
    if (this.children.length === 0)
      return this._text
    return this.children.map(c => (c instanceof FakeElement ? c.textContent : c)).join('')
  }

  set className(value: string) {
    this.attributes.class = value
  }

  get className(): string {
    return this.attributes.class ?? ''
  }

  /** Mirrors the real DOM's `label.htmlFor`, which reflects the `for` attribute. */
  set htmlFor(value: string) {
    this.attributes.for = value
  }

  get htmlFor(): string {
    return this.attributes.for ?? ''
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value
  }

  append(...nodes: (FakeElement | string)[]) {
    this.children.push(...nodes)
  }

  /**
   * A minimal serialiser, only detailed enough to prove the markup-injection
   * regression tests: every property lands as an ESCAPED attribute or escaped
   * text, never raw. There is no markup parser here — a payload can only ever
   * come out the other side inert.
   */
  get outerHTML(): string {
    const escape = (raw: string) => raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
    const tag = this.tagName.toLowerCase()
    const attrs: string[] = []
    if (this.id)
      attrs.push(`id="${escape(this.id)}"`)
    if (this.type)
      attrs.push(`type="${escape(this.type)}"`)
    if (this.checked)
      attrs.push('checked')
    for (const [name, value] of Object.entries(this.attributes))
      attrs.push(`${name}="${escape(value)}"`)
    // Raw, deliberately: whatever innerHTML was handed comes back unescaped,
    // which is exactly the regression the injection assertions must catch.
    const inner = this._html ?? this.children
      .map(child => (child instanceof FakeElement ? child.outerHTML : escape(child)))
      .join('')
    return `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>${inner}</${tag}>`
  }
}

// Exported so test/ui-render.test.ts reuses this harness rather than building
// a second one — it is what makes an innerHTML regression there fail too.
export function makeDoc() {
  return { createElement: (tag: string) => new FakeElement(tag) }
}

const fakeDocument = { createElement: (tag: string) => new FakeElement(tag) }

describe('ensureConfig', () => {
  it('fills in the shape the UI expects', () => {
    expect(ensureConfig({})).toEqual({
      platform: 'UniFiProtect',
      name: 'UniFi Protect',
      host: '',
      apiKey: '',
      defaults: DEFAULTS,
      devices: {},
    })
  })

  // `updatePluginConfig` replaces the whole platform block, so anything
  // ensureConfig drops is deleted from config.json. `_bridge` is where
  // Homebridge keeps the child bridge's username, port and PIN — rebuilding
  // from a whitelist unpaired the bridge on every save.
  it('preserves keys it does not know about through a full round-trip', () => {
    const bridge = { username: '0E:11:22:33:44:55', port: 51234, pin: '031-45-154' }
    const saved = { platform: 'UniFiProtect', host: '10.0.0.1', apiKey: 'k', _bridge: bridge }

    const config = setDeviceSetting(ensureConfig(saved), 'cam1', 'expose', false)

    expect(config._bridge).toEqual(bridge)
    expect(config.host).toBe('10.0.0.1')
    expect(config.devices.cam1).toEqual({ expose: false })
  })

  // Same hazard, sharper consequence: dropping `consoleCert` on a save would
  // throw away the pinned certificate, and the next start would silently trust
  // whatever answered — the exact failure this plugin refuses to have.
  it('preserves the trusted console certificate through a save', () => {
    const saved = { platform: 'UniFiProtect', host: '10.0.0.1', apiKey: 'k', consoleCert: 'PEM' }

    const config = setDeviceSetting(ensureConfig(saved), 'cam1', 'expose', false)

    expect(config.consoleCert).toBe('PEM')
  })
})

describe('setDeviceSetting', () => {
  it('stores a value that differs from the default', () => {
    const config = setDeviceSetting(ensureConfig({}), 'cam1', 'hksv', true)
    expect(config.devices.cam1).toEqual({ hksv: true })
  })

  it('removes an override that matches the default', () => {
    let config = setDeviceSetting(ensureConfig({}), 'cam1', 'hksv', true)
    config = setDeviceSetting(config, 'cam1', 'hksv', false)
    expect(config.devices.cam1).toBeUndefined()
  })

  it('keys by device id so a rename cannot lose settings', () => {
    const config = setDeviceSetting(ensureConfig({}), '665e623c01493103e401c8bf', 'quality', 'low')
    expect(Object.keys(config.devices)).toEqual(['665e623c01493103e401c8bf'])
  })

  it('does not mutate the input config', () => {
    const original = ensureConfig({})
    setDeviceSetting(original, 'cam1', 'hksv', true)
    expect(original.devices).toEqual({})
  })
})

describe('isOverridden / clearDeviceSetting', () => {
  const base = ensureConfig({})

  it('reports override state per key, per device', () => {
    const config = { ...base, devices: { a: { audio: true } } }
    expect(isOverridden(config, 'a', 'audio')).toBe(true)
    // Same device, a key it never set — inherited, not overridden.
    expect(isOverridden(config, 'a', 'quality')).toBe(false)
    // A different device entirely, same key — no entry at all.
    expect(isOverridden(config, 'b', 'audio')).toBe(false)
  })

  it('clears one key and keeps the others', () => {
    const config = { ...base, devices: { a: { audio: true, quality: 'high' } } }
    const next = clearDeviceSetting(config, 'a', 'audio')
    expect(next.devices.a).toEqual({ quality: 'high' })
  })

  it('removes the device entry when its last override is cleared', () => {
    const config = { ...base, devices: { a: { audio: true } } }
    expect(clearDeviceSetting(config, 'a', 'audio').devices.a).toBeUndefined()
  })

  it('is a no-op when the key was never overridden', () => {
    const config = { ...base, devices: { a: { audio: true } } }
    const next = clearDeviceSetting(config, 'a', 'quality')
    expect(next).toBe(config)
  })

  it('is a no-op when the device has no overrides at all', () => {
    const next = clearDeviceSetting(base, 'unknown', 'audio')
    expect(next).toBe(base)
  })

  it('does not mutate the input config', () => {
    const config = { ...base, devices: { a: { audio: true, quality: 'high' } } }
    clearDeviceSetting(config, 'a', 'audio')
    expect(config.devices.a).toEqual({ audio: true, quality: 'high' })
  })
})

describe('the streaming settings the UI now writes', () => {
  const minimal = { platform: 'UniFiProtect', host: '10.0.0.1', apiKey: 'k' }

  it('stores a quality override and drops it again when set back to the default', () => {
    let config = setDeviceSetting(ensureConfig({}), 'cam1', 'quality', 'low')
    expect(config.devices.cam1).toEqual({ quality: 'low' })

    config = setDeviceSetting(config, 'cam1', 'quality', 'auto')

    // Back to the default, so nothing is written — otherwise changing the
    // global default would leave every "untouched" camera pinned.
    expect(config.devices.cam1).toBeUndefined()
  })

  it('stores an audio opt-in and drops it again when switched off', () => {
    let config = setDeviceSetting(ensureConfig({}), 'cam1', 'audio', true)
    expect(config.devices.cam1).toEqual({ audio: true })

    config = setDeviceSetting(config, 'cam1', 'audio', false)

    expect(config.devices.cam1).toBeUndefined()
  })

  // What the UI writes must be what the plugin can load. Zod does NOT
  // re-validate a `.default()` value, so a UI-only value would sail through
  // every other test here and then refuse to load at startup.
  it('offers only quality values the plugin schema accepts', () => {
    for (const [value] of QUALITY_OPTIONS) {
      const parsed = parseConfig({ ...minimal, devices: { cam1: { quality: value } } })
      expect(parsed.success, value).toBe(true)
      expect(parsed.success && settingsFor(parsed.data, 'cam1').quality).toBe(value)
    }
    // ...and every value the schema accepts is offered, or a setting exists
    // that the UI can never reach.
    expect(QUALITY_OPTIONS.map(([value]) => value).sort()).toEqual(['auto', 'high', 'low', 'medium'])
  })

  // `ensureConfig` writes DEFAULTS into config.json on every save, so a value
  // that has drifted from the schema silently overrides the plugin's own
  // default for everyone who opens the settings page.
  it('keeps the UI defaults identical to the schema defaults', () => {
    const parsed = parseConfig(minimal)
    expect(parsed.success && parsed.data.defaults).toEqual(DEFAULTS)
    // And a camera with no override resolves to audio off on both sides.
    expect(parsed.success && settingsFor(parsed.data, 'cam1').audio).toBe(false)
    expect(setDeviceSetting(ensureConfig({}), 'cam1', 'audio', false).devices.cam1).toBeUndefined()
    // And the iCloud tier default is available from the UI.
    expect(defaultFor(ensureConfig(minimal), 'icloudTier')).toBe('200gb')
  })
})

describe('the global settings the UI now writes', () => {
  const minimal = { platform: 'UniFiProtect', host: '10.0.0.1', apiKey: 'k' }

  it('stores a stream cap the plugin schema accepts, at both ends of the range', () => {
    for (const value of [MAX_STREAMS_RANGE.min, 4, MAX_STREAMS_RANGE.max]) {
      const config = setGlobalSetting(ensureConfig({ ...minimal }), 'maxStreams', parseMaxStreams(String(value)))
      expect(config.maxStreams).toBe(value)
      const parsed = parseConfig(config)
      expect(parsed.success, String(value)).toBe(true)
      expect(parsed.success && parsed.data.maxStreams).toBe(value)
    }
  })

  // The bounds the UI enforces must be the bounds the schema enforces. Wider
  // here and the plugin refuses to load a config the settings page happily
  // saved; narrower and a setting exists that the UI can never reach.
  it('rejects exactly what the plugin schema rejects', () => {
    for (const raw of ['', '0', '17', '2.5', 'abc', '-3']) {
      expect(parseMaxStreams(raw), raw).toBeUndefined()
      // ...and the schema agrees, for everything that is a number at all.
      const numeric = Number(raw)
      if (Number.isFinite(numeric) && raw !== '')
        expect(parseConfig({ ...minimal, maxStreams: numeric }).success, raw).toBe(false)
    }
    expect(parseConfig({ ...minimal, maxStreams: MAX_STREAMS_RANGE.min - 1 }).success).toBe(false)
    expect(parseConfig({ ...minimal, maxStreams: MAX_STREAMS_RANGE.max + 1 }).success).toBe(false)
    expect(parseConfig({ ...minimal, maxStreams: MAX_STREAMS_RANGE.min }).success).toBe(true)
    expect(parseConfig({ ...minimal, maxStreams: MAX_STREAMS_RANGE.max }).success).toBe(true)
  })

  // Both settings are OPTIONAL. Clearing the field has to REMOVE the key: an
  // empty `ffmpegPath` would send probeFfmpeg after a binary at the empty path
  // instead of letting it search, and the config would still parse — so nothing
  // downstream would flag it.
  it('removes the key when the field is cleared rather than storing a blank', () => {
    const withValues = setGlobalSetting(
      setGlobalSetting(ensureConfig({ ...minimal }), 'maxStreams', 3),
      'ffmpegPath',
      '/opt/ffmpeg',
    )
    expect(withValues.maxStreams).toBe(3)
    expect(withValues.ffmpegPath).toBe('/opt/ffmpeg')

    const cleared = setGlobalSetting(setGlobalSetting(withValues, 'maxStreams', undefined), 'ffmpegPath', '')
    expect('maxStreams' in cleared).toBe(false)
    expect('ffmpegPath' in cleared).toBe(false)
    const parsed = parseConfig(cleared)
    expect(parsed.success && parsed.data.maxStreams).toBeUndefined()
    expect(parsed.success && parsed.data.ffmpegPath).toBeUndefined()
  })

  // `updatePluginConfig` replaces the whole platform block, so anything these
  // helpers drop is deleted from config.json — including the child bridge's
  // pairing credentials.
  it('preserves every other key, including the child bridge block', () => {
    const config = ensureConfig({ ...minimal, _bridge: { username: 'AA:BB', port: 1234 }, devices: { cam1: { audio: true } } })
    const next = setGlobalSetting(config, 'ffmpegPath', '/opt/ffmpeg')
    expect(next._bridge).toEqual({ username: 'AA:BB', port: 1234 })
    expect(next.devices).toEqual({ cam1: { audio: true } })
  })
})

describe('renderQualitySelect', () => {
  const device = { id: 'cam1' }

  it('renders every option, in order, with the current value selected', () => {
    const { wrap, select } = renderQualitySelect(fakeDocument, device, 'medium') as unknown as { wrap: FakeElement, select: FakeElement }

    expect(select.tagName).toBe('SELECT')
    const options = select.children as FakeElement[]
    expect(options.map(o => o.value)).toEqual(QUALITY_OPTIONS.map(([value]) => value))
    expect(options.filter(o => o.selected).map(o => o.value)).toEqual(['medium'])
    // The label is wired to the control, or clicking it does nothing.
    expect(wrap.attributes.for).toBe('cam1-quality')
    expect(select.id).toBe('cam1-quality')
    // Real measured resolutions, so "low" is an informed choice.
    expect(wrap.textContent).toContain('640 × 360')
  })

  it('selects nothing when the stored value is unknown, rather than guessing', () => {
    const { select } = renderQualitySelect(fakeDocument, device, 'ultra') as unknown as { select: FakeElement }
    expect((select.children as FakeElement[]).some(o => o.selected)).toBe(false)
  })

  // A device id comes straight from the Protect console, exactly like the name.
  it('renders a console-supplied device id as an inert attribute, never as markup', () => {
    const payload = '"><img src=x onerror=alert(1)>'

    const { wrap, select } = renderQualitySelect(fakeDocument, { id: payload }, 'auto') as unknown as { wrap: FakeElement, select: FakeElement }

    expect(wrap.attributes.for).toBe(`${payload}-quality`)
    // The id/for pair is a property assignment (`select.id =`, `setAttribute`),
    // never markup — this equality check IS the guard: it holds only if the
    // payload landed as a literal id string, and fails if it were ever
    // interpolated into a template that parsed it.
    expect(select.id).toBe(`${payload}-quality`)
  })
})

describe('package camera toggle', () => {
  const doorbell = { id: 'cam1', type: 'camera', hasMic: true, hasSpeaker: true, hasPackageCamera: true }

  /**
   * Exactly what index.html's render loop does — `cameraToggles` decides which
   * checkboxes exist, `renderToggle` builds each one, and the id pairs the
   * device with the setting key. Calling `shouldOfferPackageCamera` directly
   * instead would leave the rendering path untested: deleting it would keep a
   * test green while the toggle vanished from the page.
   */
  function renderControls(device: { id: string, type?: string, hasMic?: boolean, hasSpeaker?: boolean, hasPackageCamera?: boolean }) {
    const doc = makeDoc()
    return cameraToggles(device).map(({ key, label, comingLater }) => {
      const { wrap, input } = renderToggle(doc, `${device.id}-${key}`, label) as unknown as { wrap: FakeElement, input: FakeElement }
      input.checked = Boolean(defaultFor(ensureConfig(null), key))
      if (comingLater)
        wrap.className = 'up-muted'
      return { key, wrap, input }
    })
  }

  it('renders a live package checkbox for a camera that has the lens', () => {
    const rendered = renderControls(doorbell)
    const pkg = rendered.find(control => control.key === 'packageCamera')

    if (!pkg)
      throw new Error('expected a packageCamera control to be rendered')
    expect(pkg.input.type).toBe('checkbox')
    // The id/for pair is what makes clicking the label do anything, and it
    // carries the device the setting is written against.
    expect(pkg.input.id).toBe('cam1-packageCamera')
    expect(pkg.wrap.attributes.for).toBe('cam1-packageCamera')
    expect(pkg.wrap.textContent).toContain(PACKAGE_LABEL)
    // Off by default — a second accessory per doorbell is opt-in. The default
    // is `false` and not merely absent: `undefined` would make setDeviceSetting
    // store an explicit `false` override instead of clearing the key.
    expect(defaultFor(ensureConfig(null), 'packageCamera')).toBe(false)
    expect(pkg.input.checked).toBe(false)
    // Live, unlike the "arriving later" controls beside it.
    expect(pkg.wrap.className).not.toBe('up-muted')
    expect(rendered.find(control => control.key === 'hksv')?.wrap.className).toBe('up-muted')
  })

  it('renders no package checkbox for a camera without the lens', () => {
    const keys = renderControls({ ...doorbell, hasPackageCamera: false }).map(control => control.key)
    expect(keys).not.toContain('packageCamera')
    // Not passing by rendering nothing at all.
    expect(keys).toContain('hksv')
  })

  it('offers the package toggle only for a camera', () => {
    expect(shouldOfferPackageCamera({ type: 'chime', hasPackageCamera: true })).toBe(false)
    expect(renderControls({ ...doorbell, type: 'chime' }).map(c => c.key)).not.toContain('packageCamera')
  })

  it('states the frame rate in the label so nobody expects smooth video', () => {
    expect(PACKAGE_LABEL).toContain('2 fps')
  })
})

// The toggle every per-device checkbox is built from, the package one included
// — index.html calls exactly this, so an assertion here guards what actually
// renders rather than a parallel copy of it.
describe('renderToggle (XSS regression)', () => {
  const payload = '<img src=x onerror=alert(1)>'

  it('renders a console-supplied device name and id as inert text, never as markup', () => {
    const { wrap, input } = renderToggle(makeDoc(), `${payload}-packageCamera`, `${payload} ${PACKAGE_LABEL}`) as unknown as { wrap: FakeElement, input: FakeElement }

    expect(input.id).toBe(`${payload}-packageCamera`)
    expect(wrap.attributes.for).toBe(`${payload}-packageCamera`)
    // Load-bearing: textContent only returns the payload if it was assigned
    // via `.append(text)`/`textContent`, and outerHTML only stays free of a
    // raw `<img` if nothing here ever assigned `innerHTML`. Both fail under
    // an innerHTML mutation (see the fix-wave report's mutation table).
    expect(wrap.textContent).toContain(payload)
    expect(wrap.outerHTML).not.toContain('<img')
  })
})

describe('renderDeviceHeader (XSS regression)', () => {
  // A camera name comes straight from the Protect console — anyone who can
  // rename a device controls this string.
  const payload = '<img src=x onerror=alert(1)>'

  it('renders a console-supplied device name as inert text, never as markup', () => {
    // fakeDocument.createElement always returns a FakeElement at runtime; the
    // ambient .d.ts widens it to the structural MinimalDomElement shape that
    // real DOM elements also satisfy, so the cast just recovers the concrete
    // test-only type.
    const [nameEl] = renderDeviceHeader(fakeDocument, { name: payload, type: 'camera' }) as unknown as FakeElement[]
    if (!nameEl)
      throw new Error('expected renderDeviceHeader to return a name element')
    expect(nameEl.tagName).toBe('STRONG')
    // Load-bearing: fails against an innerHTML/template-literal implementation,
    // which would have parsed the payload and left `_text` empty.
    expect(nameEl.textContent).toBe(payload)
  })
})

// U2: the toggle-to-section mapping used to live in index.html's untested
// inline script (`TOGGLE_SECTION`). It now travels with the toggle itself,
// where `cameraToggles` already has full test coverage.
describe('cameraToggles sections', () => {
  const doorbell = { id: 'cam1', type: 'camera', hasMic: true, hasSpeaker: true, hasPackageCamera: true }

  it('files each toggle under the section index.html renders it in', () => {
    const bySection = Object.fromEntries(cameraToggles(doorbell).map(t => [t.key, t.section]))
    expect(bySection).toEqual({
      audio: 'Live view',
      hksv: 'Recording',
      talkback: 'Live view',
      packageCamera: 'Extra accessories',
    })
  })
})

describe('talkback toggle', () => {
  it('offers talkback on a speaker camera, enabled and marked as needing a restart', () => {
    const toggles = cameraToggles({ hasSpeaker: true, hasMic: true, hasPackageCamera: false })
    const talkback = toggles.find(t => t.key === 'talkback')
    expect(talkback?.comingLater).toBeUndefined()
    // The restart warning is now carried by renderToggle's marker (driven off
    // NEEDS_RESTART), not by the label text — see 'restart labels do not
    // duplicate the marker' below for the other half of that split.
    expect(NEEDS_RESTART.has('talkback')).toBe(true)
  })

  it('offers no talkback without a speaker', () => {
    const toggles = cameraToggles({ hasSpeaker: false, hasMic: true, hasPackageCamera: false })
    expect(toggles.find(t => t.key === 'talkback')).toBeUndefined()
  })
})

describe('iCloud tier recording limits', () => {
  it('maps each tier to its camera count', () => {
    expect(RECORDING_LIMITS['50gb']).toBe(1)
    expect(RECORDING_LIMITS['200gb']).toBe(5)
    expect(RECORDING_LIMITS['2tb']).toBe(Number.POSITIVE_INFINITY)
  })
})

// U6: a hand-edited config.json can carry any string. Without validation,
// ensureConfig would merge it unchanged, the UI would write it straight back
// on the next save, and `parseConfig` would then refuse to load it — the
// plugin left dead by a value the settings page itself persisted.
describe('icloudTier validation', () => {
  it('rejects a tier outside the three the schema knows, falling back to the default', () => {
    expect(parseIcloudTier('1tb')).toBe(DEFAULTS.icloudTier)
    expect(parseIcloudTier(undefined)).toBe(DEFAULTS.icloudTier)
  })

  it('keeps a recognised tier as-is', () => {
    for (const tier of Object.keys(RECORDING_LIMITS))
      expect(parseIcloudTier(tier)).toBe(tier)
  })

  it('ensureConfig falls back rather than persisting an unrecognised tier from config.json', () => {
    // Cast: a hand-edited config.json is exactly the untyped input this test
    // guards against — `Partial<ConfigShape>` promises a legal tier, real
    // config.json on disk does not.
    const badConfig = { platform: 'UniFiProtect', host: '10.0.0.1', apiKey: 'k', defaults: { icloudTier: '1tb' } } as unknown as Parameters<typeof ensureConfig>[0]
    const config = ensureConfig(badConfig)
    expect(config.defaults.icloudTier).toBe(DEFAULTS.icloudTier)
    // And the fallback itself is one parseConfig accepts, so the round-trip
    // this test guards against actually terminates.
    expect(parseConfig(config).success).toBe(true)
  })
})

// Apple caps HKSV by camera COUNT, not storage. `recordingCount` takes the
// discovered device list (not just `config.devices`) so a device with no
// override entry — inheriting `defaults.hksv` — is still counted, and so
// `hasPackageCamera` (a device-list-only fact) gates the package-lens
// double-count instead of trusting a possibly-stale config.json flag.
describe('recordingCount / tierWarning', () => {
  const base = ensureConfig({})
  const devices = (ids: string[]) => ids.map(id => ({ id, hasPackageCamera: true }))
  const withDevices = (deviceConfig: Record<string, DeviceOverride>, tier: IcloudTier = '200gb') =>
    ({ ...base, defaults: { ...base.defaults, icloudTier: tier }, devices: deviceConfig })

  it('counts the package accessory as its own recording camera', () => {
    const config = withDevices({ a: { hksv: true, packageCamera: true } })
    expect(recordingCount(config, devices(['a']))).toBe(2)
  })

  it('does not count a package-camera override for a device without the lens', () => {
    const config = withDevices({ a: { hksv: true, packageCamera: true } })
    expect(recordingCount(config, [{ id: 'a', hasPackageCamera: false }])).toBe(1)
  })

  it('counts a device with no override entry when defaults.hksv is on — the gap a literal config.devices scan misses', () => {
    const config = withDevices({}, '200gb')
    config.defaults.hksv = true
    expect(recordingCount(config, devices(['a', 'b']))).toBe(2)
  })

  it('does not warn at the limit', () => {
    const config = withDevices({ a: { hksv: true }, b: { hksv: true }, c: { hksv: true }, d: { hksv: true }, e: { hksv: true } })
    expect(tierWarning(config, devices(['a', 'b', 'c', 'd', 'e']))).toBeUndefined()
  })

  it('warns above the limit, naming the count and the limit', () => {
    const config = withDevices({ a: { hksv: true, packageCamera: true }, b: { hksv: true }, c: { hksv: true }, d: { hksv: true }, e: { hksv: true } })
    const message = tierWarning(config, devices(['a', 'b', 'c', 'd', 'e']))
    expect(message).toContain('6')
    expect(message).toContain('5')
  })

  it('never warns on the unlimited tier', () => {
    const ids = Array.from({ length: 20 }, (_, i) => String(i))
    const many = Object.fromEntries(ids.map(id => [id, { hksv: true }]))
    expect(tierWarning(withDevices(many, '2tb'), devices(ids))).toBeUndefined()
  })

  it('is advisory only — the config it warns about is returned unchanged, never blocked or reverted', () => {
    const config = withDevices({ a: { hksv: true, packageCamera: true }, b: { hksv: true }, c: { hksv: true }, d: { hksv: true }, e: { hksv: true } })
    expect(tierWarning(config, devices(['a', 'b', 'c', 'd', 'e']))).toBeDefined()
    expect(config.devices.a?.hksv).toBe(true)
  })
})

describe('debounce', () => {
  it('collapses a burst into one call', () => {
    vi.useFakeTimers()
    let calls = 0
    const save = debounce(() => calls++, 1000)
    save()
    save()
    save()
    expect(calls).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(calls).toBe(1)
    vi.useRealTimers()
  })

  it('calls again after the window elapses', () => {
    vi.useFakeTimers()
    let calls = 0
    const save = debounce(() => calls++, 1000)
    save()
    vi.advanceTimersByTime(1000)
    save()
    vi.advanceTimersByTime(1000)
    expect(calls).toBe(2)
    vi.useRealTimers()
  })

  // Isolates the collapsing behaviour from `clearTimeout` specifically: a
  // mutant that drops the `clearTimeout(timer)` call still schedules a new
  // timer per call, so without this a three-call burst would fire three
  // times instead of once — exactly the regression the "collapses a burst"
  // test above already catches, restated here so a review of this test alone
  // proves the mechanism, not just the outcome.
  it('resets the pending timer on every call rather than queuing one per call', () => {
    vi.useFakeTimers()
    let calls = 0
    const save = debounce(() => calls++, 1000)
    save()
    vi.advanceTimersByTime(500)
    save()
    vi.advanceTimersByTime(500)
    // Still short of 1000ms since the second call, because the first call's
    // timer must have been cleared rather than left running.
    expect(calls).toBe(0)
    vi.advanceTimersByTime(500)
    expect(calls).toBe(1)
    vi.useRealTimers()
  })
})

describe('save debounce window', () => {
  it('is one second, matching what a human click-burst needs collapsed', () => {
    expect(SAVE_DEBOUNCE_MS).toBe(1000)
  })
})

describe('settings that need a restart', () => {
  it('names exactly the settings that need a restart', () => {
    expect([...NEEDS_RESTART].sort()).toEqual(['audio', 'hksv', 'talkback'])
  })
})

describe('renderToggle restart marker', () => {
  // A generic label, deliberately free of the word "restart" itself, so this
  // isolates the marker `renderToggle` renders from `needsRestart` — not text
  // an unrelated label happens to already contain.
  it('renders a marker for a restart-requiring setting', () => {
    const { wrap } = renderToggle(makeDoc(), 'cam1-hksv', 'Some setting', true) as unknown as { wrap: FakeElement }
    expect(wrap.textContent).toContain('restart')
  })

  it('renders no marker for a setting that takes effect immediately', () => {
    const { wrap } = renderToggle(makeDoc(), 'cam1-expose', 'Some setting', false) as unknown as { wrap: FakeElement }
    expect(wrap.textContent).not.toContain('restart')
  })

  it('renders no marker by default when the caller does not say', () => {
    const { wrap } = renderToggle(makeDoc(), 'cam1-quality', 'Some setting') as unknown as { wrap: FakeElement }
    expect(wrap.textContent).not.toContain('restart')
  })
})

// index.html renders AUDIO_LABEL/TALKBACK_LABEL through exactly this call
// (renderToggle(..., NEEDS_RESTART.has(key))) — rendering it here, not just
// reading the label constants, is what proves the word only ever shows up
// once on the actual control, not twice (once in the label text, once in
// the marker).
describe('restart labels do not duplicate the marker', () => {
  it('says "restart" exactly once on the rendered audio and talkback controls', () => {
    for (const label of [AUDIO_LABEL, TALKBACK_LABEL]) {
      const { wrap } = renderToggle(makeDoc(), 'cam1-x', label, true) as unknown as { wrap: FakeElement }
      const occurrences = wrap.textContent.toLowerCase().split('restart').length - 1
      expect(occurrences, label).toBe(1)
    }
  })
})
