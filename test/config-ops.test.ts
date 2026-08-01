import { describe, expect, it } from 'vitest'
import { DEFAULTS, ensureConfig, renderDeviceHeader, setDeviceSetting } from '../homebridge-ui/public/config-ops.js'

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
  private _text = ''

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase()
  }

  set textContent(value: string) {
    this._text = value
    this.children = []
  }

  get textContent(): string {
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

  setAttribute(name: string, value: string) {
    this.attributes[name] = value
  }

  append(...nodes: (FakeElement | string)[]) {
    this.children.push(...nodes)
  }
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
