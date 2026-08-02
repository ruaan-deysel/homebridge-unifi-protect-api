import { describe, expect, it } from 'vitest'
import { cameraToggles, defaultFor, DEFAULTS, ensureConfig, MAX_STREAMS_RANGE, PACKAGE_LABEL, parseMaxStreams, QUALITY_OPTIONS, renderDeviceHeader, renderQualitySelect, renderToggle, setDeviceSetting, setGlobalSetting, shouldOfferPackageCamera } from '../homebridge-ui/public/config-ops.js'
import { parseConfig, settingsFor } from '../src/config.js'

// Minimal fake DOM — just enough to prove renderDeviceHeader never turns
// console-supplied text into markup. The load-bearing assertion is the
// `textContent` one: it holds only if the payload was assigned via textContent,
// and fails against an `innerHTML`/template-literal implementation, which would
// have parsed the string into child elements and left `_text` empty. The
// `findByTag(..., 'IMG')` check is a cheap belt-and-braces restatement — this
// FakeElement has no markup parser, so nothing here can synthesise an IMG.
// No jsdom dependency needed for the one property under test.
class FakeElement {
  tagName: string
  children: (FakeElement | string)[] = []
  attributes: Record<string, string> = {}
  /** Properties, not markup — assigning these can never parse a payload. */
  id = ''
  value = ''
  selected = false
  type = ''
  checked = false
  private _text = ''
  private _html?: string

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

function makeDoc() {
  return { createElement: (tag: string) => new FakeElement(tag) }
}

const fakeDocument = { createElement: (tag: string) => new FakeElement(tag) }

function findByTag(nodes: (FakeElement | string)[], tagName: string): FakeElement | null {
  for (const node of nodes) {
    if (node instanceof FakeElement) {
      if (node.tagName === tagName)
        return node
      const found = findByTag(node.children, tagName)
      if (found)
        return found
    }
  }
  return null
}

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
    expect(select.id).toBe(`${payload}-quality`)
    expect(findByTag([wrap], 'IMG')).toBeNull()
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
    expect(wrap.textContent).toContain(payload)
    expect(wrap.outerHTML).not.toContain('<img')
    expect(findByTag([wrap], 'IMG')).toBeNull()
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
    expect(nameEl.textContent).toBe(payload)
    expect(findByTag([nameEl], 'IMG')).toBeNull()
  })
})

describe('talkback toggle', () => {
  it('offers talkback on a speaker camera, enabled', () => {
    const toggles = cameraToggles({ hasSpeaker: true, hasMic: true, hasPackageCamera: false })
    const talkback = toggles.find(t => t.key === 'talkback')
    expect(talkback?.comingLater).toBeUndefined()
    expect(talkback?.label).toContain('restart')
  })

  it('offers no talkback without a speaker', () => {
    const toggles = cameraToggles({ hasSpeaker: false, hasMic: true, hasPackageCamera: false })
    expect(toggles.find(t => t.key === 'talkback')).toBeUndefined()
  })
})
