// DOM construction for the tabbed shell. Pure config logic lives in
// config-ops.js; this file only builds and wires elements — kept apart so
// each half stays independently testable.

/**
 * A tablist of real buttons, not clickable divs: screen readers announce the
 * role and position, and arrow-key navigation is what users of a tab strip
 * expect. Labels are OURS, never console-supplied — but they still go in as
 * textContent, because the rule is unconditional.
 */
export function renderTabs(doc, labels) {
  const tablist = doc.createElement('div')
  tablist.className = 'nav nav-tabs mb-3'
  tablist.setAttribute('role', 'tablist')
  const panes = labels.map(() => {
    const pane = doc.createElement('div')
    pane.style.display = 'none'
    return pane
  })
  const buttons = labels.map((label, i) => {
    const b = doc.createElement('button')
    b.type = 'button'
    b.className = 'nav-link'
    b.setAttribute('role', 'tab')
    b.textContent = label
    b.addEventListener('click', () => select(i))
    b.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')
        return
      const step = event.key === 'ArrowRight' ? 1 : -1
      select((i + step + labels.length) % labels.length)
    })
    tablist.append(b)
    return b
  })
  function select(index) {
    buttons.forEach((b, i) => {
      const on = i === index
      b.setAttribute('aria-selected', String(on))
      b.className = on ? 'nav-link active' : 'nav-link'
      panes[i].style.display = on ? '' : 'none'
      if (on)
        b.focus?.()
    })
    // The parent sizes the iframe from a mutation observer; swapping panes with
    // display changes height without a mutation it watches.
    globalThis.homebridge?.fixScrollHeight?.()
  }
  select(0)
  return { tablist, panes, buttons, select }
}
