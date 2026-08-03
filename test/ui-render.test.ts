import type { FakeElement } from './config-ops.test.js'
import { describe, expect, it } from 'vitest'
import { renderBadge, renderDetail, renderDeviceList, renderTabs } from '../homebridge-ui/public/ui-render.js'
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

  // Found by driving the real UI: arrows worked, Home/End did nothing. The
  // WAI-ARIA tabs pattern lists them as optional, but with four tabs they are
  // the difference between one keystroke and three.
  it('jumps to the first and last tab on Home and End', () => {
    const { tablist, select } = renderTabs(doc, ['A', 'B', 'C', 'D']) as unknown as {
      tablist: FakeElement
      select: (index: number) => void
    }
    const tab = (i: number) => tablist.children[i] as FakeElement
    const selected = () => (tablist.children as FakeElement[]).findIndex(b => b.attributes['aria-selected'] === 'true')

    select(0)
    tab(0).dispatch('keydown', { key: 'End' })
    expect(selected()).toBe(3)
    tab(3).dispatch('keydown', { key: 'Home' })
    expect(selected()).toBe(0)
  })

  // The handler must not swallow keys it does not act on, or Tab could not
  // move focus out of the tablist.
  it('leaves an unrelated key alone, selection and default action both', () => {
    const { tablist, select } = renderTabs(doc, ['A', 'B', 'C']) as unknown as {
      tablist: FakeElement
      select: (index: number) => void
    }
    select(1)
    let prevented = false
    const preventDefault = () => {
      prevented = true
    }
    ;(tablist.children[1] as FakeElement).dispatch('keydown', { key: 'Tab', preventDefault })
    expect((tablist.children[1] as FakeElement).attributes['aria-selected']).toBe('true')
    expect(prevented).toBe(false)
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
  // Attached AFTER construction, which is the order index.html uses: the count
  // stays at zero because nothing focused, not because nothing could.
  it('does not focus a tab merely from being constructed', () => {
    const { tablist } = renderTabs(doc, ['A', 'B']) as unknown as { tablist: FakeElement }
    doc.root.append(tablist)
    const buttons = tablist.children as FakeElement[]
    expect(buttons.every(b => b.focusCount === 0)).toBe(true)
  })

  it('still focuses the tab when selection is keyboard- or click-driven', () => {
    const { tablist } = renderTabs(doc, ['A', 'B']) as unknown as { tablist: FakeElement }
    // In the document first: `focus()` on a detached node is a no-op, and the
    // fake counts nothing for one either.
    doc.root.append(tablist)
    const buttons = tablist.children as FakeElement[]
    buttons[1]!.dispatch('click')
    expect(buttons[1]!.focusCount).toBe(1)
  })

  // A pane of pure prose (Help) has nothing focusable inside it, so without a
  // tabindex of its own there is no way to reach or scroll it from the keyboard.
  it('puts every pane in the Tab order so a prose-only pane is reachable', () => {
    const { panes } = renderTabs(doc, ['A', 'B', 'C']) as unknown as { panes: FakeElement[] }
    expect(panes.map(p => p.tabIndex)).toEqual([0, 0, 0])
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

  // Hiding the rows but keeping the heading left "CHIMES" floating over
  // nothing — the filtered list read as if it still had results in that group.
  it('hides a group heading whose rows are all filtered out, and brings it back', () => {
    const { list, filter } = renderDeviceList(doc, DEVICES, () => {}) as unknown as {
      list: FakeElement
      filter: (term: string) => void
    }
    const headings = (list.children as FakeElement[]).filter(c => c.className.includes('list-group-item-secondary'))
    const [cameras, chimes] = headings
    filter('door')
    // 'Doorbell' is a camera and 'Ding Dong' is not, so exactly one heading survives.
    expect(cameras?.style.display).not.toBe('none')
    expect(chimes?.style.display).toBe('none')
    filter('')
    expect(headings.map(h => h.style.display)).toEqual(['', ''])
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

  // U3: `renderDetail` used to focus the heading before returning, while the
  // pane was still detached — a silent no-op in every real browser, so
  // selecting a device never moved focus at all. The fake counted it anyway.
  // `mount` now inserts first and focuses second, and the fake only counts a
  // focus on a node reachable from the document, so this assertion is the real
  // ordering guarantee: swap the two lines in `mount` and it goes back to 0.
  it('makes the heading a programmatic focus target and focuses it once mounted', () => {
    const container = doc.createElement('div')
    doc.root.append(container)
    const { heading, mount } = renderDetail(doc, DEVICES[0]!) as unknown as {
      heading: FakeElement
      mount: (container: FakeElement) => void
    }
    expect(heading.tabIndex).toBe(-1)
    // Nothing focused yet — building the pane must not claim focus on its own.
    expect(heading.focusCount).toBe(0)
    mount(container)
    expect(heading.focusCount).toBe(1)
  })

  // Found by driving the real UI: selecting a chime drew "Live view",
  // "Recording" and "Extra accessories" as bordered dividers with nothing
  // under them, because capability gating leaves those bodies empty. Same
  // defect the device list already fixes for its group headings.
  it('hides a section whose body has no controls, label and all', () => {
    const container = doc.createElement('div')
    doc.root.append(container)
    const { bodies, mount, pane } = renderDetail(doc, DEVICES[2]!) as unknown as {
      bodies: Record<string, FakeElement>
      pane: FakeElement
      mount: (container: FakeElement) => void
    }
    // Only General gets a control for a chime, exactly as the caller fills it.
    bodies.General!.append(doc.createElement('input'))
    mount(container)

    const labelOf = (name: string) =>
      (pane.children as FakeElement[]).find(c => c.textContent === name)
    expect(labelOf('General')!.style.display).toBe('')
    expect(bodies.General!.style.display).toBe('')
    for (const empty of ['Live view', 'Recording', 'Extra accessories']) {
      expect(labelOf(empty)!.style.display, empty).toBe('none')
      expect(bodies[empty]!.style.display, empty).toBe('none')
    }
  })

  // The Recording body ALWAYS carries the tier-warning element, which hides
  // itself when there is nothing to warn about — so "has children" is not the
  // same question as "has anything to show".
  it('treats a section holding only a hidden element as empty', () => {
    const container = doc.createElement('div')
    doc.root.append(container)
    const { bodies, mount, pane } = renderDetail(doc, DEVICES[1]!) as unknown as {
      bodies: Record<string, FakeElement>
      pane: FakeElement
      mount: (container: FakeElement) => void
    }
    const hiddenWarning = doc.createElement('div')
    hiddenWarning.style.display = 'none'
    bodies.Recording!.append(hiddenWarning)
    mount(container)

    const label = (pane.children as FakeElement[]).find(c => c.textContent === 'Recording')
    expect(label!.style.display).toBe('none')

    // ...and it comes back the moment the warning has something to say.
    hiddenWarning.style.display = ''
    mount(container)
    expect(label!.style.display).toBe('')
  })

  it('replaces whatever the detail pane held before', () => {
    const container = doc.createElement('div')
    doc.root.append(container)
    container.textContent = 'Select a device from the list.'
    const { pane, mount } = renderDetail(doc, DEVICES[1]!) as unknown as {
      pane: FakeElement
      mount: (container: FakeElement) => void
    }
    mount(container)
    expect(container.children).toEqual([pane])
    expect(container.textContent).toContain('Backyard')
  })

  // A label sitting above a body is only a heading visually; without the pair
  // a screen reader reads "Recording" as a stray line and then the controls
  // with no idea they belong to it.
  it('ties each section body to its label with role=group and aria-labelledby', () => {
    const { pane, bodies } = renderDetail(doc, DEVICES[0]!) as unknown as {
      pane: FakeElement
      bodies: Record<string, FakeElement>
    }
    const labelText = new Map(
      (pane.children as FakeElement[]).filter(c => c.id).map(c => [c.id, c.textContent]),
    )
    for (const [name, body] of Object.entries(bodies)) {
      expect(body.attributes.role).toBe('group')
      // The id actually resolves to the label carrying this section's name —
      // a dangling aria-labelledby announces nothing.
      expect(labelText.get(body.attributes['aria-labelledby']!)).toBe(name)
    }
  })

  // Two panes in one document must not share label ids, or aria-labelledby
  // points at whichever one happens to be first.
  it('gives two panes disjoint section label ids', () => {
    const first = renderDetail(doc, DEVICES[0]!) as unknown as { bodies: Record<string, FakeElement> }
    const second = renderDetail(doc, DEVICES[1]!) as unknown as { bodies: Record<string, FakeElement> }
    const ids = (b: Record<string, FakeElement>) => Object.values(b).map(x => x.attributes['aria-labelledby'])
    expect(new Set([...ids(first.bodies), ...ids(second.bodies)]).size).toBe(8)
  })
})

describe('renderBadge', () => {
  it('renders a default badge with no reset control when inherited', () => {
    const { badge, reset } = renderBadge(doc, false, () => {}) as unknown as { badge: FakeElement, reset: FakeElement | undefined }
    expect(badge.textContent).toBe('default')
    expect(reset).toBeUndefined()
  })

  it('renders an overridden badge with a reset control when not inherited', () => {
    const { badge, reset } = renderBadge(doc, true, () => {}) as unknown as { badge: FakeElement, reset: FakeElement | undefined }
    expect(badge.textContent).toBe('overridden')
    expect(reset).toBeDefined()
    expect(reset?.tagName).toBe('BUTTON')
  })

  // Every reset button on a detail pane renders the same word. Without a
  // per-setting accessible name a screen reader user hears "reset" four times
  // over and cannot tell which setting any of them belongs to.
  it('names the setting on the reset control, so four resets are not four bare "reset"s', () => {
    const { reset } = renderBadge(doc, true, () => {}, 'HomeKit Secure Video') as unknown as { reset: FakeElement }
    expect(reset.attributes['aria-label']).toContain('HomeKit Secure Video')
    // The visible text stays short; the accessible name is the long one.
    expect(reset.textContent).toBe('reset')
    const other = renderBadge(doc, true, () => {}, 'Live view quality') as unknown as { reset: FakeElement }
    expect(other.reset.attributes['aria-label']).not.toBe(reset.attributes['aria-label'])
  })

  it('the reset control calls back when clicked', () => {
    const calls: number[] = []
    const { reset } = renderBadge(doc, true, () => calls.push(1)) as unknown as { reset: FakeElement }
    reset.dispatch('click')
    expect(calls).toEqual([1])
  })
})
