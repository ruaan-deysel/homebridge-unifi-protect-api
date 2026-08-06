import type { DeviceOverride, IcloudTier } from '../homebridge-ui/public/config-ops.js'
import { describe, expect, it, vi } from 'vitest'
import { AUDIO_LABEL, cameraToggles, clearDeviceSetting, debounce, defaultFor, DEFAULTS, ensureConfig, HKSV_LABEL, isOverridden, MAX_STREAMS_RANGE, NEEDS_RESTART, PACKAGE_LABEL, parseIcloudTier, parseMaxStreams, QUALITY_OPTIONS, RECORDING_LIMITS, recordingCount, renderDeviceHeader, renderQualitySelect, renderToggle, SAVE_DEBOUNCE_MS, setDeviceSetting, setDiscoveredDevices, setGlobalSetting, shouldOfferPackageCamera, TALKBACK_LABEL, TIER_LABELS, tierWarning } from '../homebridge-ui/public/config-ops.js'
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
  /**
   * `-1`, matching what a real `div` reports when it carries no `tabindex`
   * attribute — NOT `0`. Defaulting to `0` made "every pane is in the Tab
   * order" pass against a renderer that never set it (a green mutation), which
   * is the same class of defect as the `focus()` counter below.
   */
  tabIndex = -1
  private listeners = new Map<string, ((event: Record<string, unknown>) => void)[]>()
  private _text = ''
  private _html?: string

  addEventListener(type: string, handler: (event: Record<string, unknown>) => void) {
    const forType = this.listeners.get(type) ?? []
    forType.push(handler)
    this.listeners.set(type, forType)
  }

  /**
   * Fires a synthetic event at every listener registered for `type`, and
   * RETURNS what each handler returned. The page's handlers are `async`, so
   * without the returned promises a test could only await guesswork — and a
   * handler that threw would surface as an unhandled rejection long after the
   * assertion it should have failed.
   */
  dispatch(type: string, event: Record<string, unknown> = {}): unknown[] {
    const results: unknown[] = (this.listeners.get(type) ?? []).map(handler => handler(event))
    // A real event also runs the `on<type>` PROPERTY, not just the registered
    // listeners. `oninput` is the one the page assigns (the device filter), and
    // firing only the listeners meant filtering could not be driven through the
    // page at all — deleting the assignment left every test green.
    if (type === 'input' && this.oninput)
      results.push(this.oninput())
    return results
  }

  /** Awaits every handler, so a rejecting one fails the test that fired it. */
  async fire(type: string, event: Record<string, unknown> = {}) {
    await Promise.all(this.dispatch(type, event))
  }

  /**
   * Attachment, modelled only as far as `focus()` needs it. `append` and
   * `replaceChildren` set this; nothing else does, because nothing else in the
   * code under test detaches a node.
   */
  parent: FakeElement | null = null
  /** Set on the node `makeDoc()` hands back as the document root. */
  isDocumentRoot = false

  /**
   * Real focus has no visual effect in this harness, but the call itself is
   * load-bearing: U3 (selection moves focus to the detail heading) is proven
   * by counting calls here, not by reading source.
   *
   * It counts ONLY when the node is reachable from the document root, because
   * that is the one thing a real browser does differently: `focus()` on a
   * detached node is a silent no-op. A counter that ignored attachment made
   * `expect(el.focusCount).toBe(1)` pass for code that focused a node it had
   * not inserted yet — which is exactly the defect this harness let through
   * (renderDetail focused its heading before the caller mounted the pane).
   * Do not simplify this back to an unconditional increment.
   */
  focusCount = 0
  focus() {
    let node = this.parent
    while (node && !node.isDocumentRoot)
      node = node.parent
    if (this.isDocumentRoot || node)
      this.focusCount++
  }

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

  /** `null` for an absent attribute, as the real DOM returns. */
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }

  append(...nodes: (FakeElement | string)[]) {
    for (const node of nodes) {
      // A real `append` MOVES an already-parented node, it does not clone it.
      // The page relies on exactly that when it relocates each static pane
      // into the tab shell, so a fake that left the node in both places would
      // model a document the browser never produces.
      if (node instanceof FakeElement)
        node.remove()
    }
    this.children.push(...nodes)
    for (const node of nodes) {
      if (node instanceof FakeElement)
        node.parent = this
    }
  }

  /** `<input disabled>`, as a property — the `comingLater` toggles set it. */
  disabled = false
  /**
   * The one legacy `on*` handler the page assigns (the device filter). A
   * property, like the real DOM's.
   */
  oninput: (() => void) | null = null

  /** Inserts nodes ahead of this one, as `Element.before` does. */
  before(...nodes: (FakeElement | string)[]) {
    if (!this.parent)
      return
    // Detached first, exactly as `append` does: `before` MOVES an already
    // parented node too, and a fake that left it in both places models a
    // document no browser produces. The index is read afterwards, since
    // removing an earlier sibling shifts it.
    for (const node of nodes) {
      if (node instanceof FakeElement)
        node.remove()
    }
    const at = this.parent.children.indexOf(this)
    this.parent.children.splice(at, 0, ...nodes)
    for (const node of nodes) {
      if (node instanceof FakeElement)
        node.parent = this.parent
    }
  }

  /** Detaches this node, as `Element.remove` does. */
  remove() {
    if (!this.parent)
      return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }

  replaceChildren(...nodes: (FakeElement | string)[]) {
    for (const node of this.children) {
      if (node instanceof FakeElement)
        node.parent = null
    }
    this.children = []
    this._text = ''
    this._html = undefined
    this.append(...nodes)
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
//
// `root` stands in for the document: a test that wants `focus()` to count has
// to attach the node to it first, exactly as the page has to insert an element
// before focusing it.
export function makeDoc() {
  const root = new FakeElement('body')
  root.isDocumentRoot = true
  return { createElement: (tag: string) => new FakeElement(tag), root }
}

const fakeDocument = { createElement: (tag: string) => new FakeElement(tag) }

// The harness itself, where the page depends on the real DOM's behaviour. The
// tab shell is built with `tabRoot.before(tablist, ...panes)` and then moves
// the static panes into it with `append` — a fake that copied instead of moved
// would model a document with two of every control, and every id lookup below
// would be testing the wrong node.
describe('the fake DOM moves nodes, as the real one does', () => {
  it('detaches an already-parented node on before(), not just on append()', () => {
    const oldParent = new FakeElement('div')
    const moved = new FakeElement('span')
    oldParent.append(moved)

    const newParent = new FakeElement('div')
    const anchor = new FakeElement('p')
    newParent.append(anchor)
    anchor.before(moved)

    expect(oldParent.children).toEqual([])
    expect(newParent.children).toEqual([moved, anchor])
    expect(moved.parent).toBe(newParent)
  })

  it('keeps the insertion point right when the moved node is an earlier sibling', () => {
    const parent = new FakeElement('div')
    const first = new FakeElement('span')
    const anchor = new FakeElement('p')
    parent.append(first, anchor)

    anchor.before(first)

    expect(parent.children).toEqual([first, anchor])
  })
})

describe('ensureConfig', () => {
  it('fills in the shape the UI expects', () => {
    expect(ensureConfig({})).toEqual({
      platform: 'UniFiProtect',
      name: 'UniFi Protect',
      host: '',
      apiKey: '',
      defaults: DEFAULTS,
      devices: {},
      discoveredDevices: [],
    })
  })

  it('defaults discoveredDevices to [] when absent', () => {
    expect(ensureConfig({ platform: 'UniFiProtect', host: '10.0.0.1', apiKey: 'k' }).discoveredDevices).toEqual([])
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

describe('setDiscoveredDevices', () => {
  const DEVICE = { id: 'cam1', name: 'Front Door', type: 'camera', hasSpeaker: true, hasMic: true, hasLedStatus: false, hasPackageCamera: false, smartDetectTypes: [] }

  it('replaces the discoveredDevices field', () => {
    const config = ensureConfig({})
    const next = setDiscoveredDevices(config, [DEVICE])
    expect(next.discoveredDevices).toEqual([DEVICE])
  })

  it('does not mutate the original config', () => {
    const config = ensureConfig({})
    setDiscoveredDevices(config, [DEVICE])
    expect(config.discoveredDevices).toEqual([])
  })

  it('copies the supplied list so later mutation cannot alter the config', () => {
    const config = ensureConfig({})
    const input = [DEVICE]
    const next = setDiscoveredDevices(config, input)
    input.push({ ...DEVICE, id: 'cam2' })
    expect(next.discoveredDevices).toEqual([DEVICE])
  })

  it('preserves all other config fields', () => {
    const config = ensureConfig({ platform: 'UniFiProtect', host: '10.0.0.1', apiKey: 'k' })
    const next = setDiscoveredDevices(config, [DEVICE])
    expect(next.host).toBe('10.0.0.1')
    expect(next.apiKey).toBe('k')
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

  // An explicit `false` IS an override — the test above only ever asserted
  // `true`, so a truthiness check in place of the `!== undefined` would have
  // survived: a camera deliberately switched off would show "default" and
  // offer no reset.
  it('reports an explicit false as overridden, not as an absent key', () => {
    const config = { ...base, devices: { a: { audio: false } } }
    expect(isOverridden(config, 'a', 'audio')).toBe(true)
    // And the absent key next to it still is not.
    expect(isOverridden(config, 'a', 'talkback')).toBe(false)
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
    // The label is wired to the control, or clicking it does nothing. It is a
    // CHILD of the wrapper now, not the wrapper itself: the wrapper became a
    // flex row so the caller's badge sits on the same line as the select
    // instead of being pushed below it.
    const caption = (wrap.children as FakeElement[]).find(c => c.tagName === 'LABEL')
    expect(caption?.attributes.for).toBe('cam1-quality')
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

    const caption = (wrap.children as FakeElement[]).find(c => c.tagName === 'LABEL')
    expect(caption?.attributes.for).toBe(`${payload}-quality`)
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
    return cameraToggles(device).map(({ key, label }) => {
      const { wrap, input, caption } = renderToggle(doc, `${device.id}-${key}`, label, NEEDS_RESTART.has(key as 'audio')) as unknown as { wrap: FakeElement, input: FakeElement, caption: FakeElement }
      input.checked = Boolean(defaultFor(ensureConfig(null), key))
      return { key, wrap, input, caption }
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
    // The id/for pair now lives on the caption label — the wrapper is a div,
    // so the badge and reset button the detail pane appends to it are not
    // swallowed into the checkbox's accessible name.
    expect(pkg.caption.attributes.for).toBe('cam1-packageCamera')
    expect(pkg.wrap.tagName).toBe('DIV')
    expect(pkg.wrap.textContent).toContain(PACKAGE_LABEL)
    // Off by default — a second accessory per doorbell is opt-in. The default
    // is `false` and not merely absent: `undefined` would make setDeviceSetting
    // store an explicit `false` override instead of clearing the key.
    expect(defaultFor(ensureConfig(null), 'packageCamera')).toBe(false)
    expect(pkg.input.checked).toBe(false)
    // Bootstrap renders a switch only while these two survive on the wrapper —
    // without them the control silently reverts to a 13 px checkbox, and this
    // plugin ships no CSS of its own to put it back.
    for (const key of ['packageCamera', 'hksv']) {
      const wrap = rendered.find(control => control.key === key)?.wrap
      expect(wrap?.className.split(' '), key).toEqual(expect.arrayContaining(['form-check', 'form-switch']))
    }
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

  it('labels the toggle as a separate accessory so its effect is clear', () => {
    expect(PACKAGE_LABEL).toContain('separate accessory')
  })
})

// The toggle every per-device checkbox is built from, the package one included
// — index.html calls exactly this, so an assertion here guards what actually
// renders rather than a parallel copy of it.
describe('renderToggle (XSS regression)', () => {
  const payload = '<img src=x onerror=alert(1)>'

  it('renders a console-supplied device name and id as inert text, never as markup', () => {
    const { wrap, input, caption } = renderToggle(makeDoc(), `${payload}-packageCamera`, `${payload} ${PACKAGE_LABEL}`) as unknown as { wrap: FakeElement, input: FakeElement, caption: FakeElement }

    expect(input.id).toBe(`${payload}-packageCamera`)
    expect(caption.attributes.for).toBe(`${payload}-packageCamera`)
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

describe('recording toggle', () => {
  it('offers recording as a live control', () => {
    const entry = cameraToggles({ hasSpeaker: false, hasMic: true, hasPackageCamera: false }).find(t => t.key === 'hksv')
    expect(entry).toBeDefined()
    // The restart warning is carried by renderToggle's marker (driven off
    // NEEDS_RESTART), not by the label text — see 'restart labels do not
    // duplicate the marker' for the other half of that split.
    expect(NEEDS_RESTART.has('hksv')).toBe(true)
    expect(entry!.section).toBe('Recording')
  })
})

describe('talkback toggle', () => {
  it('offers talkback on a speaker camera, enabled and marked as needing a restart', () => {
    const toggles = cameraToggles({ hasSpeaker: true, hasMic: true, hasPackageCamera: false })
    const talkback = toggles.find(t => t.key === 'talkback')
    expect(talkback).toBeDefined()
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

  // Found by driving the real UI: the warning printed the raw config key back
  // at a user who had chosen "50 GB" from a menu — "…supports 1 on the 50gb
  // tier". A tier with no label would reintroduce that, so cover the whole set.
  it('has a human label for every tier it knows a limit for', () => {
    expect(Object.keys(TIER_LABELS).sort()).toEqual(Object.keys(RECORDING_LIMITS).sort())
    for (const label of Object.values(TIER_LABELS))
      expect(label).toMatch(/\d/)
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
  const devices = (ids: string[]) => ids.map(id => ({ id, type: 'camera', hasPackageCamera: true }))
  const withDevices = (deviceConfig: Record<string, DeviceOverride>, tier: IcloudTier = '200gb') =>
    ({ ...base, defaults: { ...base.defaults, icloudTier: tier }, devices: deviceConfig })

  // `attachPackageCamera` builds its CameraController with NO `recording` key,
  // so the package accessory never advertises HKSV and cannot occupy one of
  // Apple's camera slots. This test previously pinned the opposite — a count
  // of 2 — which warned 200 GB users off a sixth camera they were entitled to.
  it('does not count the package lens, which never records', () => {
    const withLens = withDevices({ a: { hksv: true, packageCamera: true } })
    const withoutLens = withDevices({ a: { hksv: true } })
    expect(recordingCount(withLens, devices(['a']))).toBe(1)
    // Enabling the lens moves nothing: asserted against the same config minus
    // the flag, so a re-introduced double-count fails here rather than being
    // absorbed by a hardcoded expectation.
    expect(recordingCount(withLens, devices(['a']))).toBe(recordingCount(withoutLens, devices(['a'])))
  })

  // A light, sensor or chime is never an HKSV camera, even if it somehow
  // carries an hksv override or inherits a true default from
  // `defaults.hksv` — only `device.type === 'camera'` counts.
  it('does not count a non-camera device, override or inherited default', () => {
    const config = withDevices({ a: { hksv: true }, b: {} })
    config.defaults.hksv = true
    const mixed = [
      { id: 'a', type: 'light', hasPackageCamera: false },
      { id: 'b', type: 'camera', hasPackageCamera: false },
    ]
    expect(recordingCount(config, mixed)).toBe(1)

    // Direction check: a lone non-camera with hksv on must count zero. Without
    // this, a flipped `type === 'camera'` comparison above still passes the
    // mixed-list assertion by coincidence (skip the camera, count the light).
    const lightOnly = withDevices({ a: { hksv: true } })
    expect(recordingCount(lightOnly, [{ id: 'a', type: 'light', hasPackageCamera: false }])).toBe(0)
  })

  it('does not count a device that is not recording, lens or no lens', () => {
    const config = withDevices({ a: { hksv: false, packageCamera: true } })
    expect(recordingCount(config, devices(['a']))).toBe(0)
  })

  it('counts a device with no override entry when defaults.hksv is on — the gap a literal config.devices scan misses', () => {
    const config = withDevices({}, '200gb')
    config.defaults.hksv = true
    expect(recordingCount(config, devices(['a', 'b']))).toBe(2)
  })

  // The `??` in `settings?.hksv ?? defaultFor(...)` has to be `??` and not
  // `||`: an explicit `false` override against a `true` default is the only
  // input that tells the two apart, and `||` would fall through to the default
  // and count a camera the user switched off.
  it('lets an explicit false override a true default rather than falling through to it', () => {
    const config = withDevices({ a: { hksv: false } })
    config.defaults.hksv = true
    expect(recordingCount(config, devices(['a', 'b']))).toBe(1)
  })

  it('does not warn at the limit', () => {
    const config = withDevices({ a: { hksv: true }, b: { hksv: true }, c: { hksv: true }, d: { hksv: true }, e: { hksv: true } })
    expect(tierWarning(config, devices(['a', 'b', 'c', 'd', 'e']))).toBeUndefined()
  })

  it('warns above the limit, naming the count and the limit', () => {
    const config = withDevices({ a: { hksv: true }, b: { hksv: true }, c: { hksv: true }, d: { hksv: true }, e: { hksv: true }, f: { hksv: true } })
    const message = tierWarning(config, devices(['a', 'b', 'c', 'd', 'e', 'f']))
    expect(message).toContain('6')
    expect(message).toContain('5')
  })

  it('never warns on the unlimited tier', () => {
    const ids = Array.from({ length: 20 }, (_, i) => String(i))
    const many = Object.fromEntries(ids.map(id => [id, { hksv: true }]))
    expect(tierWarning(withDevices(many, '2tb'), devices(ids))).toBeUndefined()
  })

  // A hand-edited `icloudTier: "1tb"` has no RECORDING_LIMITS entry. Read raw,
  // `limit` was `undefined`, `count <= undefined` is false for any count, and
  // every user with a hand-edited tier saw "…supports undefined on the 1tb
  // tier" permanently — including one recording camera on what should be a
  // silent default. `parseIcloudTier` is what makes the banner honest.
  it('judges an unrecognised tier by the default tier, never by undefined', () => {
    const unknownTier = { a: { hksv: true } }
    // Cast for the same reason ensureConfig's test does: config.json on disk
    // can hold any string, the type cannot.
    const config = withDevices(unknownTier, '1tb' as unknown as IcloudTier)
    // One camera is inside the 200gb default's limit of 5, so: no warning.
    expect(tierWarning(config, devices(['a']))).toBeUndefined()

    const many = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map(id => [id, { hksv: true }]))
    const over = withDevices(many, '1tb' as unknown as IcloudTier)
    const message = tierWarning(over, devices(['a', 'b', 'c', 'd', 'e', 'f']))
    // And when it does warn, it names the tier and limit actually in force —
    // never the string 'undefined', and never the unrecognised tier. The tier
    // is named the way the user picked it ("200 GB"), not by its config key —
    // this assertion used to require the key, which pinned that defect in place.
    expect(message).toContain(TIER_LABELS[DEFAULTS.icloudTier as keyof typeof TIER_LABELS])
    expect(message).not.toContain('undefined')
    expect(message).not.toContain('1tb')
    expect(message).not.toContain('200gb')
    expect(message).toContain('5')
  })

  it('is advisory only — the config it warns about is returned unchanged, never blocked or reverted', () => {
    const config = withDevices({ a: { hksv: true, packageCamera: true }, b: { hksv: true }, c: { hksv: true }, d: { hksv: true }, e: { hksv: true }, f: { hksv: true } })
    expect(tierWarning(config, devices(['a', 'b', 'c', 'd', 'e', 'f']))).toBeDefined()
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

// Closing the settings modal inside the 1 s window used to discard the pending
// write in silence — the UI had already shown the change and config.json never
// received it. index.html calls `flush()` from visibilitychange/pagehide.
describe('debounce flush', () => {
  it('runs the pending call immediately, with the latest arguments', () => {
    vi.useFakeTimers()
    const seen: string[] = []
    const save = debounce((value: string) => seen.push(value), 1000)
    save('first')
    save('second')
    expect(seen).toEqual([])
    save.flush()
    expect(seen).toEqual(['second'])
    vi.useRealTimers()
  })

  it('cancels the timer so a flushed call never fires twice', () => {
    vi.useFakeTimers()
    let calls = 0
    const save = debounce(() => calls++, 1000)
    save()
    save.flush()
    vi.advanceTimersByTime(5000)
    expect(calls).toBe(1)
    vi.useRealTimers()
  })

  // The unload handlers fire on every close, not just the ones with an edit
  // pending — a flush with nothing to write must not write anything.
  it('is a no-op when nothing is pending, before or after a completed call', () => {
    vi.useFakeTimers()
    let calls = 0
    const save = debounce(() => calls++, 1000)
    save.flush()
    expect(calls).toBe(0)
    save()
    vi.advanceTimersByTime(1000)
    expect(calls).toBe(1)
    save.flush()
    expect(calls).toBe(1)
    vi.useRealTimers()
  })

  it('still debounces normally after a flush', () => {
    vi.useFakeTimers()
    let calls = 0
    const save = debounce(() => calls++, 1000)
    save()
    save.flush()
    save()
    save()
    expect(calls).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(calls).toBe(2)
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

// Bootstrap 5 renders a checkbox as a switch only when the wrapper carries
// `form-check form-switch` AND the input carries `form-check-input`; without
// them it is the 13 px default checkbox the rebuild set out to replace. The
// classes come from the Bootstrap Homebridge injects — this plugin ships no
// CSS — so the class strings themselves are the whole mechanism.
describe('renderToggle is a real switch', () => {
  it('carries the Bootstrap switch classes on both the wrapper and the input', () => {
    const { wrap, input } = renderToggle(makeDoc(), 'cam1-hksv', 'Some setting') as unknown as { wrap: FakeElement, input: FakeElement }
    expect(wrap.className.split(' ')).toEqual(expect.arrayContaining(['form-check', 'form-switch']))
    expect(input.className.split(' ')).toContain('form-check-input')
  })
})

// The checkbox's accessible name is the text of the `<label for>` bound to it.
// While the wrapper WAS that label, everything appended afterwards — the
// restart marker, and the badge and reset button the detail pane adds — sat
// inside it, so a screen reader announced "Live view audio restart required
// overridden reset" as the switch's name, and the reset button was a button
// nested in a label (invalid, and label activation is suppressed for it).
describe('renderToggle accessible name', () => {
  /** Stands in for `renderBadge`'s output without importing ui-render here. */
  function renderBadgeLike(doc: ReturnType<typeof makeDoc>) {
    const badge = doc.createElement('span')
    badge.textContent = 'overridden'
    const reset = doc.createElement('button')
    reset.textContent = 'reset'
    return { badge, reset }
  }

  it('names the control with its label alone, marker and badges outside it', () => {
    const doc = makeDoc()
    const { wrap, caption, input } = renderToggle(doc, 'cam1-audio', AUDIO_LABEL, true) as unknown as {
      wrap: FakeElement
      caption: FakeElement
      input: FakeElement
    }
    // What a caller appends afterwards, exactly as the detail pane does.
    const { badge, reset } = renderBadgeLike(doc)
    wrap.append(badge, reset)

    expect(caption.tagName).toBe('LABEL')
    expect(caption.attributes.for).toBe(input.id)
    // The whole accessible name, and nothing else in it.
    expect(caption.textContent).toBe(AUDIO_LABEL)
    // The wrapper still shows the marker and the badge — they moved out of the
    // name, not off the page.
    expect(wrap.textContent).toContain('restart required')
    expect(wrap.textContent).toContain('overridden')
    // A button inside a label is the invalid part; it must be a sibling.
    expect(caption.children).toHaveLength(0)
    expect(wrap.children).toContain(reset)
    // Bootstrap only renders a switch while these survive the restructure.
    expect(wrap.className.split(' ')).toEqual(expect.arrayContaining(['form-check', 'form-switch']))
    expect(input.className.split(' ')).toContain('form-check-input')
    expect(caption.className.split(' ')).toContain('form-check-label')
  })

  // The other half of that fix, and the half it originally shipped without:
  // moving the marker out of the name left it announced to NOBODY. The name is
  // the label alone AND the restart requirement reaches the control — one
  // without the other is the regression.
  it('reaches the control with the restart requirement through its description', () => {
    const doc = makeDoc()
    const { wrap, caption, input } = renderToggle(doc, 'cam1-talkback', TALKBACK_LABEL, true) as unknown as {
      wrap: FakeElement
      caption: FakeElement
      input: FakeElement
    }

    // Still just the label — the description must not leak back into the name.
    expect(caption.textContent).toBe(TALKBACK_LABEL)

    const describedBy = (input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
    expect(describedBy).not.toHaveLength(0)
    // Resolved against the DOM, not compared to a string: an id pointing at no
    // element describes nothing, which is what a screen reader would find.
    const described = describedBy.map((id) => {
      const target = (wrap.children.filter(child => child instanceof FakeElement) as FakeElement[]).find(child => child.id === id)
      if (!target)
        throw new Error(`aria-describedby points at #${id}, which is not on the control`)
      return target.textContent
    })
    expect(described).toContain('restart required')
  })

  it('describes nothing when the setting takes effect immediately', () => {
    const { input } = renderToggle(makeDoc(), 'cam1-expose', 'Some setting', false) as unknown as { input: FakeElement }
    expect(input.getAttribute('aria-describedby')).toBeNull()
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

// index.html renders AUDIO_LABEL/TALKBACK_LABEL/HKSV_LABEL through exactly
// this call (renderToggle(..., NEEDS_RESTART.has(key))) — rendering it here,
// not just reading the label constants, is what proves the word only ever
// shows up once on the actual control, not twice (once in the label text,
// once in the marker).
describe('restart labels do not duplicate the marker', () => {
  it('says "restart" exactly once on the rendered audio, talkback and hksv controls', () => {
    for (const label of [AUDIO_LABEL, TALKBACK_LABEL, HKSV_LABEL]) {
      const { wrap } = renderToggle(makeDoc(), 'cam1-x', label, true) as unknown as { wrap: FakeElement }
      const occurrences = wrap.textContent.toLowerCase().split('restart').length - 1
      expect(occurrences, label).toBe(1)
    }
  })
})
