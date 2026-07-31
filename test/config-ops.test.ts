import { describe, expect, it } from 'vitest'
import { DEFAULTS, ensureConfig, renderDeviceHeader, setDeviceSetting } from '../homebridge-ui/public/config-ops.js'

// Minimal fake DOM — just enough to prove renderDeviceHeader never turns
// console-supplied text into markup. `innerHTML` here stands in for what a
// real browser would do: parse `<tag>` into a live element (which is exactly
// how a device named `<img src=x onerror=...>` would execute script). No
// jsdom dependency needed for this one property.
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

  // Naive markup parser — enough to model "did this string get parsed as an
  // element" without a real HTML parser. Test-only; never used by shipped code.
  set innerHTML(html: string) {
    this.children = []
    const tagPattern = /<([a-z][a-z0-9]*)\b[^>]*>/gi
    let match: RegExpExecArray | null
    let cursor = 0
    // eslint-disable-next-line no-cond-assign
    while ((match = tagPattern.exec(html))) {
      if (match.index > cursor)
        this.children.push(html.slice(cursor, match.index))
      this.children.push(new FakeElement(match[1] ?? ''))
      cursor = tagPattern.lastIndex
    }
    if (cursor < html.length)
      this.children.push(html.slice(cursor))
  }

  // Paired getter only to satisfy accessor-pairs lint — never read in this test.
  get innerHTML(): string {
    return this.children.map(c => (c instanceof FakeElement ? c.tagName : c)).join('')
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

  it('would have executed under the old innerHTML approach — this is the bug being guarded against', () => {
    const vulnerable = fakeDocument.createElement('strong')
    vulnerable.innerHTML = `<strong>${payload}</strong>`
    expect(findByTag([vulnerable], 'IMG')).not.toBeNull()
  })
})
