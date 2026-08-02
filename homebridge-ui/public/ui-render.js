// DOM construction for the tabbed shell. Pure config logic lives in
// config-ops.js; this file only builds and wires elements — kept apart so
// each half stays independently testable.

/**
 * A tablist of real buttons, not clickable divs: screen readers announce the
 * role and position, and arrow-key navigation is what users of a tab strip
 * expect. Labels are OURS, never console-supplied — but they still go in as
 * textContent, because the rule is unconditional.
 *
 * Each button/pane pair is cross-referenced (`aria-controls`/`aria-labelledby`
 * against real `id`s) and the pane carries `role="tabpanel"`, so assistive
 * tech can tell which pane a tab owns — without that, a screen reader has no
 * way to associate the two. Roving `tabindex` (only the selected button is in
 * the Tab order, `0`; the rest are `-1`) keeps the strip a single Tab stop,
 * as arrow keys — not Tab — are how a tablist's own controls are supposed to
 * move between tabs.
 */
export function renderTabs(doc, labels) {
  const tablist = doc.createElement('div')
  tablist.className = 'nav nav-tabs mb-3'
  tablist.setAttribute('role', 'tablist')
  const panes = labels.map((_, i) => {
    const pane = doc.createElement('div')
    pane.style.display = 'none'
    pane.setAttribute('role', 'tabpanel')
    pane.id = `tabpanel-${i}`
    pane.setAttribute('aria-labelledby', `tab-${i}`)
    return pane
  })
  const buttons = labels.map((label, i) => {
    const b = doc.createElement('button')
    b.type = 'button'
    b.className = 'nav-link'
    b.setAttribute('role', 'tab')
    b.id = `tab-${i}`
    b.setAttribute('aria-controls', `tabpanel-${i}`)
    b.tabIndex = -1
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
  // `focus` defaults to true — clicking or arrow-keying a tab should move
  // focus there. The one caller that opts out is construction itself: merely
  // building the shell (below) must not steal focus out of whatever the host
  // page was already focused on.
  function select(index, { focus = true } = {}) {
    buttons.forEach((b, i) => {
      const on = i === index
      b.setAttribute('aria-selected', String(on))
      b.className = on ? 'nav-link active' : 'nav-link'
      b.tabIndex = on ? 0 : -1
      panes[i].style.display = on ? '' : 'none'
      if (on && focus)
        b.focus?.()
    })
    // The parent sizes the iframe from a mutation observer; swapping panes with
    // display changes height without a mutation it watches.
    globalThis.homebridge?.fixScrollHeight?.()
  }
  select(0, { focus: false })
  return { tablist, panes, buttons, select }
}

const GROUP_LABELS = { camera: 'Cameras', light: 'Lights', sensor: 'Sensors', chime: 'Chimes', viewer: 'Viewers' }

/**
 * A list, not a card per device: with every device expanded the page grew
 * without bound and finding one camera meant scrolling past the rest.
 *
 * `name` is console-supplied and attacker-controlled. It lands as textContent
 * on a row that is built with createElement — never as markup, and never
 * interpolated into a class or an attribute that could break out. `id` lands
 * via `dataset`, which is a property assignment too, not markup.
 */
export function renderDeviceList(doc, devices, onSelect) {
  const list = doc.createElement('div')
  list.className = 'list-group'
  const rowEls = []
  for (const type of Object.keys(GROUP_LABELS)) {
    const group = devices.filter(d => d.type === type)
    if (group.length === 0)
      continue
    const heading = doc.createElement('div')
    heading.className = 'list-group-item list-group-item-secondary py-1 small text-uppercase'
    heading.textContent = GROUP_LABELS[type]
    list.append(heading)
    for (const device of group) {
      const row = doc.createElement('button')
      row.type = 'button'
      row.className = 'list-group-item list-group-item-action'
      row.dataset.id = device.id
      row.textContent = device.name
      row.addEventListener('click', () => {
        for (const other of rowEls)
          other.className = 'list-group-item list-group-item-action'
        row.className = 'list-group-item list-group-item-action active'
        onSelect(device.id)
      })
      list.append(row)
      rowEls.push(row)
    }
  }
  const filter = (term) => {
    const needle = term.trim().toLowerCase()
    for (const row of rowEls)
      row.style.display = row.textContent.toLowerCase().includes(needle) ? '' : 'none'
  }
  return { list, filter, rows: () => rowEls }
}

/**
 * Which value a control is showing: the global default, or this device's own.
 * Making that visible is the point — the flat UI showed only the resulting
 * value, so there was no way to tell, and no way to get back to the default.
 * `onReset` is only wired when overridden; there is nothing to reset otherwise.
 */
export function renderBadge(doc, overridden, onReset) {
  const badge = doc.createElement('span')
  badge.className = overridden ? 'badge text-bg-warning ms-2' : 'badge text-bg-secondary ms-2'
  badge.textContent = overridden ? 'overridden' : 'default'
  if (!overridden)
    return { badge, reset: undefined }
  const reset = doc.createElement('button')
  reset.type = 'button'
  reset.className = 'btn btn-link btn-sm p-0 ms-2'
  reset.textContent = 'reset'
  reset.addEventListener('click', () => onReset())
  return { badge, reset }
}

const SECTIONS = ['General', 'Live view', 'Recording', 'Extra accessories']

/**
 * One device's settings, grouped so related controls read as related.
 * `device.name` lands as textContent on the heading — attacker-controlled,
 * never markup. `heading.tabIndex = -1` makes it a programmatic focus target,
 * and `renderDetail` focuses it itself before returning: the caller (index.html's
 * `showDetail`) never has to remember to, which is what made "selection moves
 * focus to the heading" untestable before — the call lived only in untested
 * inline script. Now the two facts (focusable, focused) are the same call and
 * one test proves both.
 */
export function renderDetail(doc, device) {
  const pane = doc.createElement('div')
  const heading = doc.createElement('h5')
  heading.tabIndex = -1
  heading.textContent = device.name
  pane.append(heading)
  const bodies = {}
  for (const name of SECTIONS) {
    const label = doc.createElement('div')
    label.className = 'text-body-secondary text-uppercase small border-bottom mt-3 mb-2'
    label.textContent = name
    const body = doc.createElement('div')
    pane.append(label, body)
    bodies[name] = body
  }
  heading.focus()
  return { pane, heading, bodies }
}
