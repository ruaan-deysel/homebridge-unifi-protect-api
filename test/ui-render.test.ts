import type { FakeElement } from './config-ops.test.js'
import { describe, expect, it } from 'vitest'
import { renderTabs } from '../homebridge-ui/public/ui-render.js'
import { makeDoc } from './config-ops.test.js'

const doc = makeDoc()

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
})
