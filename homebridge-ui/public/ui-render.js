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
    // A tabpanel has to be in the Tab order itself, or a pane whose content is
    // not focusable (the Help pane is all prose) can never be reached — arrow
    // keys move between tabs, and Tab from the strip has to land somewhere.
    pane.tabIndex = 0
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
  const groups = []
  for (const type of Object.keys(GROUP_LABELS)) {
    const group = devices.filter(d => d.type === type)
    if (group.length === 0)
      continue
    const heading = doc.createElement('div')
    heading.className = 'list-group-item list-group-item-secondary py-1 small text-uppercase'
    heading.textContent = GROUP_LABELS[type]
    list.append(heading)
    const groupRows = []
    groups.push({ heading, rows: groupRows })
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
      groupRows.push(row)
    }
  }
  const filter = (term) => {
    const needle = term.trim().toLowerCase()
    for (const row of rowEls)
      row.style.display = row.textContent.toLowerCase().includes(needle) ? '' : 'none'
    // A heading over nothing is worse than no heading: filtering to one camera
    // otherwise still shows SENSORS and CHIMES with empty space under them.
    for (const group of groups)
      group.heading.style.display = group.rows.some(row => row.style.display !== 'none') ? '' : 'none'
  }
  return { list, filter, rows: () => rowEls }
}

/**
 * Which value a control is showing: the global default, or this device's own.
 * Making that visible is the point — the flat UI showed only the resulting
 * value, so there was no way to tell, and no way to get back to the default.
 * `onReset` is only wired when overridden; there is nothing to reset otherwise.
 *
 * `label` names the setting on the reset button's `aria-label`. Every reset
 * button on the pane otherwise reads as a bare "reset", so a screen reader
 * user tabbing the pane hears the same word four times with no way to tell
 * which setting each one belongs to. `label` is a label WE own, but it is set
 * as a property, never markup, like every other string here.
 */
export function renderBadge(doc, overridden, onReset, label = '') {
  const badge = doc.createElement('span')
  badge.className = overridden ? 'badge text-bg-warning ms-2' : 'badge text-bg-secondary ms-2'
  badge.textContent = overridden ? 'overridden' : 'default'
  if (!overridden)
    return { badge, reset: undefined }
  const reset = doc.createElement('button')
  reset.type = 'button'
  reset.className = 'btn btn-link btn-sm p-0 ms-2'
  reset.textContent = 'reset'
  reset.setAttribute('aria-label', label ? `Reset ${label} to the default` : 'Reset to the default')
  reset.addEventListener('click', () => onReset())
  return { badge, reset }
}

const SECTIONS = ['General', 'Live view', 'Recording', 'Extra accessories']

// Section labels need ids for `aria-labelledby`, and the ids have to be unique
// across every pane ever built in this document — a counter is the only source
// of that which does not involve `device.id` (console-supplied) or collide when
// the same device is selected twice.
let sectionSeq = 0

/**
 * One device's settings, grouped so related controls read as related.
 * `device.name` lands as textContent on the heading — attacker-controlled,
 * never markup. `heading.tabIndex = -1` makes it a programmatic focus target.
 *
 * Focus is NOT moved here. `focus()` on a node that is not in the document is
 * a silent no-op in every browser, and this pane is built detached — the
 * caller inserts it afterwards. Focusing here therefore did nothing at all,
 * while a test counting `focus()` calls on a fake happily said it worked. So
 * `mount(container)` owns both halves: it inserts the pane and THEN focuses,
 * which is the only order in which the focus actually happens. Callers use
 * `mount`, not their own `replaceChildren`.
 *
 * Each section's body is tied to its label with `role="group"` +
 * `aria-labelledby`, so a screen reader announces "Recording" when it reaches
 * the recording controls instead of reading the label as a stray line of text.
 */
export function renderDetail(doc, device) {
  const pane = doc.createElement('div')
  const heading = doc.createElement('h5')
  heading.tabIndex = -1
  heading.textContent = device.name
  pane.append(heading)
  const bodies = {}
  for (const name of SECTIONS) {
    const labelId = `detail-section-${sectionSeq++}`
    const label = doc.createElement('div')
    label.className = 'text-body-secondary text-uppercase small border-bottom mt-3 mb-2'
    label.id = labelId
    label.textContent = name
    const body = doc.createElement('div')
    body.setAttribute('role', 'group')
    body.setAttribute('aria-labelledby', labelId)
    pane.append(label, body)
    bodies[name] = body
  }
  const mount = (container) => {
    container.replaceChildren(pane)
    heading.focus()
    // Selecting a device swaps the whole right-hand pane, which changes the
    // document's height. The parent sizes the iframe from a mutation observer,
    // but it is watching its own side — without this the modal keeps the old
    // height and grows a scrollbar instead of the iframe growing.
    globalThis.homebridge?.fixScrollHeight?.()
  }
  return { pane, heading, bodies, mount }
}
