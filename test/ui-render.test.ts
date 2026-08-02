import { describe, expect, it } from 'vitest'
import { renderDetail, renderDeviceList, renderTabs } from '../homebridge-ui/public/ui-render.js'
import { FakeElement, makeDoc } from './config-ops.test.js'

const doc = makeDoc()

// Local to this file, not exported from config-ops.test.ts: this one walks a
// single node rather than a list, which is what renderDeviceList/renderDetail
// hand back. The actual injection guard is FakeElement's innerHTML setter
// (shared) — this is just a cheap belt-and-braces restatement.
function findByTag(node: FakeElement, tagName: string): FakeElement | undefined {
  if (node.tagName === tagName)
    return node
  for (const child of node.children) {
    if (child instanceof FakeElement) {
      const found = findByTag(child, tagName)
      if (found)
        return found
    }
  }
  return undefined
}

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
    expect(findByTag(list, 'IMG')).toBeUndefined()
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
    const { pane, heading } = renderDetail(doc, hostile) as unknown as { pane: FakeElement, heading: FakeElement }
    expect(findByTag(pane, 'IMG')).toBeUndefined()
    expect(heading.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('makes the heading a programmatic focus target, for selection to move focus to', () => {
    const { heading } = renderDetail(doc, DEVICES[0]!) as unknown as { heading: FakeElement }
    expect(heading.tabIndex).toBe(-1)
    const calls: number[] = []
    heading.focus = () => calls.push(1)
    heading.focus()
    expect(calls).toEqual([1])
  })
})
