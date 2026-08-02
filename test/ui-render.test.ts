import type { FakeElement } from './config-ops.test.js'
import { describe, expect, it } from 'vitest'
import { renderDetail, renderDeviceList, renderTabs } from '../homebridge-ui/public/ui-render.js'
import { makeDoc } from './config-ops.test.js'

const doc = makeDoc()

const DEVICES = [
  { id: 'a', name: 'Doorbell', type: 'camera', hasSpeaker: true, hasMic: true, hasPackageCamera: true },
  { id: 'b', name: 'Backyard', type: 'camera', hasSpeaker: false, hasMic: true, hasPackageCamera: false },
  { id: 'c', name: 'Ding Dong', type: 'chime', hasSpeaker: false, hasMic: false, hasPackageCamera: false },
]

describe('renderTabs', () => {
  it('builds a tablist of real buttons with one selected', () => {
    const { tablist, panes } = renderTabs(doc, ['Connection', 'Defaults', 'Devices', 'Help']) as unknown as {
      tablist: FakeElement
      panes: FakeElement[]
    }
    expect(tablist.attributes.role).toBe('tablist')
    expect(tablist.children.every(c => (c as FakeElement).tagName === 'BUTTON')).toBe(true)
    expect((tablist.children as FakeElement[]).filter(c => c.attributes['aria-selected'] === 'true')).toHaveLength(1)
    expect(panes).toHaveLength(4)
  })

  it('wraps arrow-key navigation at both ends', () => {
    const { tablist, select } = renderTabs(doc, ['A', 'B', 'C']) as unknown as {
      tablist: FakeElement
      select: (index: number) => void
    }
    select(0)
    ;(tablist.children[0] as FakeElement).dispatch('keydown', { key: 'ArrowLeft' })
    expect((tablist.children[2] as FakeElement).attributes['aria-selected']).toBe('true')
    ;(tablist.children[2] as FakeElement).dispatch('keydown', { key: 'ArrowRight' })
    expect((tablist.children[0] as FakeElement).attributes['aria-selected']).toBe('true')
  })

  it('shows exactly one pane at a time', () => {
    const { panes, select } = renderTabs(doc, ['A', 'B']) as unknown as {
      panes: FakeElement[]
      select: (index: number) => void
    }
    select(1)
    expect(panes.filter(p => p.style.display !== 'none')).toHaveLength(1)
    expect(panes[1]?.style.display).not.toBe('none')
  })

  it('clicking a tab selects it', () => {
    const { tablist, panes } = renderTabs(doc, ['A', 'B']) as unknown as {
      tablist: FakeElement
      panes: FakeElement[]
    }
    ;(tablist.children[1] as FakeElement).dispatch('click')
    expect((tablist.children[1] as FakeElement).attributes['aria-selected']).toBe('true')
    expect(panes[1]?.style.display).not.toBe('none')
    expect(panes[0]?.style.display).toBe('none')
  })

  // The parent iframe sizes itself from a mutation observer, and swapping a
  // pane's `display` does not fire one — nothing resizes the frame unless
  // renderTabs calls this itself after every switch.
  it('calls homebridge.fixScrollHeight() after a tab switch', () => {
    const calls: number[] = []
    // @ts-expect-error test-only global stub; the real homebridge object is
    // injected by the parent iframe and is not present under vitest.
    globalThis.homebridge = { fixScrollHeight: () => calls.push(1) }
    try {
      const { select } = renderTabs(doc, ['A', 'B']) as unknown as { select: (index: number) => void }
      const before = calls.length
      select(1)
      expect(calls.length).toBeGreaterThan(before)
    }
    finally {
      // @ts-expect-error see above
      delete globalThis.homebridge
    }
  })

  // U4: without id/aria-controls/aria-labelledby/role="tabpanel", a screen
  // reader has no way to tell which pane belongs to which tab button.
  it('cross-references every button and pane for assistive tech', () => {
    const { tablist, panes } = renderTabs(doc, ['A', 'B', 'C']) as unknown as {
      tablist: FakeElement
      panes: FakeElement[]
    }
    const buttons = tablist.children as FakeElement[]
    buttons.forEach((b, i) => {
      expect(b.id).toBeTruthy()
      expect(b.attributes['aria-controls']).toBe(panes[i]!.id)
    })
    panes.forEach((p, i) => {
      expect(p.attributes.role).toBe('tabpanel')
      expect(p.id).toBeTruthy()
      expect(p.attributes['aria-labelledby']).toBe(buttons[i]!.id)
    })
    // Every id is unique — a duplicate would make aria-controls/aria-labelledby
    // ambiguous.
    expect(new Set(buttons.map(b => b.id)).size).toBe(buttons.length)
    expect(new Set(panes.map(p => p.id)).size).toBe(panes.length)
  })

  // U4: a roving tabindex keeps the strip a single Tab stop — arrow keys, not
  // Tab, move between tabs, which is what a tablist's own controls are
  // supposed to do.
  it('keeps exactly one button in the Tab order at a time', () => {
    const { tablist, select } = renderTabs(doc, ['A', 'B', 'C']) as unknown as {
      tablist: FakeElement
      select: (index: number) => void
    }
    const buttons = tablist.children as FakeElement[]
    expect(buttons.map(b => b.tabIndex)).toEqual([0, -1, -1])
    select(2)
    expect(buttons.map(b => b.tabIndex)).toEqual([-1, -1, 0])
  })

  // U5: building the shell must not steal focus from wherever the host page
  // already had it — only a user actually driving the tabs should move focus.
  it('does not focus a tab merely from being constructed', () => {
    const { tablist } = renderTabs(doc, ['A', 'B']) as unknown as { tablist: FakeElement }
    const buttons = tablist.children as FakeElement[]
    expect(buttons.every(b => b.focusCount === 0)).toBe(true)
  })

  it('still focuses the tab when selection is keyboard- or click-driven', () => {
    const { tablist } = renderTabs(doc, ['A', 'B']) as unknown as { tablist: FakeElement }
    const buttons = tablist.children as FakeElement[]
    buttons[1]!.dispatch('click')
    expect(buttons[1]!.focusCount).toBe(1)
  })
})

describe('renderDeviceList', () => {
  it('groups devices by type', () => {
    const { list } = renderDeviceList(doc, DEVICES, () => {}) as unknown as { list: FakeElement }
    const headings = (list.children as FakeElement[]).filter(c => c.className.includes('list-group-item-secondary'))
    expect(headings.map(h => h.textContent)).toEqual(['Cameras', 'Chimes'])
  })

  it('filters by name, case-insensitively', () => {
    const { filter, rows } = renderDeviceList(doc, DEVICES, () => {}) as unknown as {
      filter: (term: string) => void
      rows: () => FakeElement[]
    }
    filter('door')
    expect(rows().filter(r => r.style.display !== 'none').map(r => r.dataset.id)).toEqual(['a'])
  })

  it('never lets a hostile device name become an element', () => {
    const hostile = [{ ...DEVICES[0]!, name: '<img src=x onerror=alert(1)>' }]
    const { list } = renderDeviceList(doc, hostile, () => {}) as unknown as { list: FakeElement }
    // Load-bearing: `textContent` only returns the raw payload if the row
    // assigned it via `.textContent =`. An `innerHTML` mutation would have
    // parsed the string into (fake) child elements and returned '' here —
    // proven by mutating renderDeviceList and watching this assertion fail
    // (see the fix-wave report's mutation table). A prior `findByTag(...,
    // 'IMG')` assertion here could never fail — FakeElement's `innerHTML`
    // setter never creates child elements — and has been removed.
    expect(list.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('reports the selected device id', () => {
    const seen: string[] = []
    const { rows } = renderDeviceList(doc, DEVICES, id => seen.push(id)) as unknown as { rows: () => FakeElement[] }
    rows()[1]?.dispatch('click')
    expect(seen).toEqual(['b'])
  })

  it('marks exactly one row selected, moving selection off a previously active row', () => {
    const { rows } = renderDeviceList(doc, DEVICES, () => {}) as unknown as { rows: () => FakeElement[] }
    const [first, second] = rows()
    first?.dispatch('click')
    expect(first?.className).toContain('active')
    second?.dispatch('click')
    expect(first?.className).not.toContain('active')
    expect(second?.className).toContain('active')
    expect(rows().filter(r => r.className.includes('active'))).toHaveLength(1)
  })
})

describe('renderDetail', () => {
  it('groups controls under General / Live view / Recording / Extra accessories', () => {
    const { bodies } = renderDetail(doc, DEVICES[0]!) as unknown as { bodies: Record<string, FakeElement> }
    expect(Object.keys(bodies)).toEqual(['General', 'Live view', 'Recording', 'Extra accessories'])
  })

  it('never lets a hostile device name become an element in the heading', () => {
    const hostile = { ...DEVICES[0]!, name: '<img src=x onerror=alert(1)>' }
    const { heading } = renderDetail(doc, hostile) as unknown as { heading: FakeElement }
    // Load-bearing for the same reason as the device-list test above: this
    // fails against an innerHTML-based renderer. The former `findByTag(pane,
    // 'IMG')` companion assertion could never fail and has been removed.
    expect(heading.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  // U3: two facts tested in isolation (heading is focusable; a spied
  // `focus()` records a call) don't prove selection actually moves focus
  // there — the wiring lived only in index.html's untested `showDetail`.
  // `renderDetail` now focuses its own heading before returning, so the
  // thing every caller (including selection) triggers IS this call, and this
  // one test covers both facts genuinely.
  it('makes the heading a programmatic focus target and focuses it, which is how selection reaches it', () => {
    const { heading } = renderDetail(doc, DEVICES[0]!) as unknown as { heading: FakeElement }
    expect(heading.tabIndex).toBe(-1)
    expect(heading.focusCount).toBe(1)
  })
})
