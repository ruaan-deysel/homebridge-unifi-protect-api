import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { startUi } from '../homebridge-ui/public/app.js'
import { FakeElement } from './config-ops.test.js'

// index.html's behaviour used to live in a `<script type="module">` inside the
// markup, where eslint resolved no config and no test could import it. That is
// how `(ok ? homebridge.toast.success : homebridge.toast.error)(text)` shipped:
// selecting the method detaches it from `homebridge.toast`, plugin-ui-utils
// implements both as methods calling `this._postMessage(...)`, and because
// `report()` runs before discovery, ONE throw left the settings page with no
// devices and a dead Test Connection button.
//
// So the fake below is deliberately UNFORGIVING: `toast` is a class whose
// methods go through `this`, exactly like the real one. The first reproduction
// of this outage used an arrow-function toast that never touched `this` and
// pronounced the broken page healthy.

class FakeToast {
  messages: { kind: string, text: string }[] = []

  _postMessage(kind: string, text: string) {
    this.messages.push({ kind, text })
  }

  success(text: string) {
    this._postMessage('success', text)
  }

  error(text: string) {
    this._postMessage('error', text)
  }
}

// The ids come from the real index.html rather than a hand-written list: the
// markup and the module are separate files now, and nothing else would notice
// an id renamed in one and not the other.
const PAGE_IDS = [...new Set(
  [...readFileSync(new URL('../homebridge-ui/public/index.html', import.meta.url), 'utf8')
    .matchAll(/\bid="([^"]+)"/g)].map(match => match[1] as string),
)]

function makePage() {
  const root = new FakeElement('body')
  root.isDocumentRoot = true
  const byId = new Map<string, FakeElement>()
  for (const id of PAGE_IDS) {
    const el = new FakeElement('div')
    el.id = id
    byId.set(id, el)
    root.append(el)
  }
  return {
    root,
    byId,
    visibilityState: 'visible',
    createElement: (tag: string) => new FakeElement(tag),
    getElementById(id: string) {
      const el = byId.get(id)
      if (!el)
        throw new Error(`index.html has no #${id}`)
      return el
    },
    addEventListener(type: string, handler: () => void) {
      root.addEventListener(type, handler)
    },
  }
}

const CAMERA = { id: 'cam1', name: 'Front Door', type: 'camera', hasSpeaker: true, hasMic: true, hasPackageCamera: true }
const CHIME = { id: 'chime1', name: 'Ding Dong', type: 'chime', hasSpeaker: false, hasMic: false, hasPackageCamera: false }

/** What the server-side `/console-cert` handler answers with. */
interface CertResult {
  pem: string
  fingerprint: string
  trustedFingerprint: string | null
  matches: boolean | null
}

const FIRST_SIGHT: CertResult = { pem: 'PEM', fingerprint: 'AA:BB', trustedFingerprint: null, matches: null }

interface HomebridgeOptions {
  /** Rejects the write when it returns a message, otherwise the write lands. */
  rejectUpdate?: () => string | undefined
  /** Rejects the config.json write itself — the debounced half of a save. */
  rejectSave?: () => string | undefined
  rejectRequest?: (path: string) => string | undefined
  /**
   * Holds a call in flight until the returned promise resolves, so a test can
   * have two writes (or two clicks) overlapping on purpose. `undefined` lets
   * the call through.
   */
  holdUpdate?: () => Promise<void> | undefined
  holdRequest?: (path: string) => Promise<void> | undefined
  cert?: CertResult
}

function makeHomebridge({ rejectUpdate = () => undefined, rejectSave = () => undefined, rejectRequest = () => undefined, holdUpdate = () => undefined, holdRequest = () => undefined, cert = FIRST_SIGHT }: HomebridgeOptions = {}) {
  const requests: { path: string, payload: Record<string, unknown> }[] = []
  const updates: Record<string, unknown>[] = []
  let saves = 0
  return {
    toast: new FakeToast(),
    requests,
    updates,
    saved: () => saves,
    /** The config the runtime is holding — what a reload would show. */
    stored: () => updates.at(-1),
    getPluginConfig: async () => [{ platform: 'UniFiProtect', name: 'UniFi Protect', host: '10.0.0.1', apiKey: 'k' }],
    updatePluginConfig: async ([next]: [Record<string, unknown>]) => {
      await holdUpdate()
      const failure = rejectUpdate()
      if (failure)
        throw new Error(failure)
      updates.push(structuredClone(next))
    },
    savePluginConfig: async () => {
      const failure = rejectSave()
      if (failure)
        throw new Error(failure)
      saves++
    },
    request: async (path: string, payload: Record<string, unknown>) => {
      requests.push({ path, payload })
      await holdRequest(path)
      const failure = rejectRequest(path)
      if (failure)
        throw new Error(failure)
      if (path === '/console-cert')
        return cert
      if (path === '/test-connection')
        return { nvrName: 'Dream Machine', version: '5.0.0' }
      return { devices: [CAMERA, CHIME] }
    },
    fixScrollHeight: () => {},
  }
}

/** Depth-first walk, so a control can be found wherever the page put it. */
function findAll(node: FakeElement, match: (el: FakeElement) => boolean): FakeElement[] {
  const found = match(node) ? [node] : []
  for (const child of node.children) {
    if (child instanceof FakeElement)
      found.push(...findAll(child, match))
  }
  return found
}

function byId(node: FakeElement, id: string) {
  const [found] = findAll(node, el => el.id === id)
  if (!found)
    throw new Error(`no rendered element with id ${id}`)
  return found
}

async function start(options: HomebridgeOptions = {}) {
  const doc = makePage()
  const homebridge = makeHomebridge(options)
  const win = new FakeElement('window')
  // No cast: the fakes satisfy the shapes the ambient .d.ts declares for
  // `startUi`, which is the point of taking every dependency as an argument.
  // `homebridge` used to be declared `unknown` there, so this line proved
  // nothing about it — a fake missing `toast` entirely type-checked fine. It is
  // a real interface now, and dropping a method from `makeHomebridge` fails
  // `npm run lint` here.
  await startUi(doc, homebridge, win)
  return { doc, homebridge, win }
}

describe('the fake toast is as strict as plugin-ui-utils', () => {
  // This test guards the HARNESS, not the page. A toast whose methods ignore
  // `this` cannot fail the way the real one did, so every other test in this
  // file rests on this one assertion.
  it('throws when a toast method is detached from its object', () => {
    const toast = new FakeToast()
    const detached = toast.success
    expect(() => detached('hello')).toThrow()
    expect(() => toast.success('hello')).not.toThrow()
    expect(toast.messages).toEqual([{ kind: 'success', text: 'hello' }])
  })
})

describe('test connection, end to end', () => {
  it('checks the certificate, the key and the devices, then renders the list', async () => {
    const { doc, homebridge } = await start()
    doc.getElementById('host').value = '10.0.0.5'
    doc.getElementById('apiKey').value = 'secret'

    await doc.getElementById('test').fire('click')

    // All three, in order: a throw anywhere in `report` used to stop the page
    // dead between them, leaving the device list empty forever.
    expect(homebridge.requests.map(r => r.path)).toEqual(['/console-cert', '/test-connection', '/discover'])
    // The key is only ever sent after the certificate call.
    expect(homebridge.requests[0]?.payload).not.toHaveProperty('apiKey')
    expect(homebridge.requests[1]?.payload.apiKey).toBe('secret')

    // The rows actually rendered — the visible half of the outage.
    const rows = findAll(doc.getElementById('device-list'), el => el.tagName === 'BUTTON')
    expect(rows.map(row => row.textContent)).toEqual(['Front Door', 'Ding Dong'])
    expect(rows.map(row => row.dataset.id)).toEqual(['cam1', 'chime1'])

    // Both halves of `report`: the aria-live line and the toast.
    expect(doc.getElementById('status').textContent).toBe('Connected — Dream Machine, Protect 5.0.0')
    expect(homebridge.toast.messages).toEqual([{ kind: 'success', text: 'Connected — Dream Machine, Protect 5.0.0' }])
    // And the credentials reached the runtime, with the newly pinned cert.
    expect(homebridge.stored()).toMatchObject({ host: '10.0.0.5', apiKey: 'secret', consoleCert: 'PEM' })
  })

  it('reports a failed certificate read through the toast and gives the button back', async () => {
    const { doc, homebridge } = await start({ rejectRequest: path => path === '/console-cert' ? 'no route to host' : undefined })

    await doc.getElementById('test').fire('click')

    expect(homebridge.toast.messages).toEqual([{ kind: 'error', text: 'no route to host' }])
    expect(doc.getElementById('status').textContent).toBe('no route to host')
    // The API key never left the page.
    expect(homebridge.requests.map(r => r.path)).toEqual(['/console-cert'])
    expect(doc.getElementById('test').disabled).toBe(false)
  })

  // ~18 s of TCP timeout is how long an unreachable console takes to answer the
  // certificate read, and the button used to stay live for all of it: repeat
  // clicks fired CONCURRENT reads whose completions raced to write the same
  // `config` and the same aria-live line. The guard was asserted only as
  // `disabled === false` afterwards — which is the fake's initial value, so
  // deleting the guard outright left every test in this file green.
  it('ignores a second click while the first check is still running', async () => {
    let release = () => {}
    const inFlight = new Promise<void>((resolve) => {
      release = resolve
    })
    const { doc, homebridge } = await start({ holdRequest: path => path === '/console-cert' ? inFlight : undefined })

    const test = doc.getElementById('test')
    const first = test.fire('click')
    expect(test.disabled).toBe(true)

    // The impatient second click, while the console is still not answering.
    await test.fire('click')
    expect(homebridge.requests.filter(r => r.path === '/console-cert')).toHaveLength(1)

    release()
    await first
    // And the button comes back, or Test Connection is dead for good.
    expect(test.disabled).toBe(false)
    expect(homebridge.requests.filter(r => r.path === '/console-cert')).toHaveLength(1)
  })

  it('selecting a device shows its controls', async () => {
    const { doc } = await start()
    await doc.getElementById('test').fire('click')

    const [row] = findAll(doc.getElementById('device-list'), el => el.dataset.id === 'cam1')
    row?.dispatch('click')

    const detail = doc.getElementById('device-detail')
    expect(findAll(detail, el => el.tagName === 'H5')[0]?.textContent).toBe('Front Door')
    // Capability-driven: the doorbell has a speaker and a package lens.
    for (const key of ['expose', 'audio', 'talkback', 'hksv', 'packageCamera', 'quality'])
      expect(() => byId(detail, `cam1-${key}`), key).not.toThrow()
  })
})

// Callers mutate `config` BEFORE calling save(), so a rejected
// updatePluginConfig used to leave the control AND the in-memory config
// showing a value that never reached disk — while the comment above it
// claimed it would "leave everything showing what is on disk".
describe('a rejected write rolls back', () => {
  it('restores a host-wide field and its control', async () => {
    let fail = true
    const { doc, homebridge } = await start({ rejectUpdate: () => fail ? 'disk full' : undefined })

    const maxStreams = doc.getElementById('maxStreams')
    maxStreams.value = '4'
    await maxStreams.fire('change')

    expect(homebridge.toast.messages).toEqual([{ kind: 'error', text: 'Could not save config.json: disk full' }])
    // The control is back on what is on disk, not on the rejected 4.
    expect(maxStreams.value).toBe('')

    // And the in-memory config went back too: the next write must not smuggle
    // the rejected value along with an unrelated change.
    fail = false
    doc.getElementById('ffmpegPath').value = '/usr/bin/ffmpeg'
    await doc.getElementById('ffmpegPath').fire('change')
    expect(homebridge.stored()).toMatchObject({ ffmpegPath: '/usr/bin/ffmpeg' })
    expect(homebridge.stored()).not.toHaveProperty('maxStreams')
  })

  it('restores a per-device toggle and its override', async () => {
    let fail = false
    const { doc, homebridge } = await start({ rejectUpdate: () => fail ? 'read-only file system' : undefined })
    await doc.getElementById('test').fire('click')
    findAll(doc.getElementById('device-list'), el => el.dataset.id === 'cam1')[0]?.dispatch('click')

    const detail = doc.getElementById('device-detail')
    const hksv = byId(detail, 'cam1-hksv')
    expect(hksv.checked).toBe(false)

    fail = true
    hksv.checked = true
    await hksv.fire('change')

    expect(hksv.checked).toBe(false)
    expect(homebridge.toast.messages.at(-1)).toEqual({ kind: 'error', text: 'Could not save config.json: read-only file system' })
    // The badge follows the restored config, so it cannot claim an override
    // that was never written.
    expect(hksv.parent?.textContent).toContain('default')
    expect(hksv.parent?.textContent).not.toContain('overridden')

    // A later successful write carries no trace of the rejected override.
    fail = false
    const expose = byId(detail, 'cam1-expose')
    expose.checked = false
    await expose.fire('change')
    expect(homebridge.stored()?.devices).toEqual({ cam1: { expose: false } })
  })

  it('does not claim a certificate is trusted when storing it failed', async () => {
    // A certificate that no longer matches: the page refuses the connection
    // and offers an explicit re-trust button.
    const { doc, homebridge } = await start({
      rejectUpdate: () => 'disk full',
      cert: { pem: 'NEW-PEM', fingerprint: 'CC:DD', trustedFingerprint: 'AA:BB', matches: false },
    })
    const trust = doc.getElementById('trust')
    await doc.getElementById('test').fire('click')
    // The API key was never sent.
    expect(homebridge.requests.map(r => r.path)).toEqual(['/console-cert'])

    const [button] = findAll(trust, el => el.tagName === 'BUTTON')
    expect(button?.textContent).toBe('Trust this certificate')
    await button?.fire('click')

    expect(trust.textContent).not.toContain('now trusted')
    expect(homebridge.toast.messages.at(-1)).toEqual({ kind: 'error', text: 'Could not save config.json: disk full' })
  })

  // The connection test dropped `save()`'s answer entirely. On a refused write
  // the host, the key and the certificate it had just pinned all rolled back —
  // while the success toast stayed up, the trust panel went on saying "every
  // later connection is pinned to it", and discovery ran against credentials
  // the page no longer held.
  it('does not report a connection it could not store', async () => {
    const { doc, homebridge } = await start({ rejectUpdate: () => 'disk full' })
    doc.getElementById('host').value = '10.0.0.5'
    doc.getElementById('apiKey').value = 'secret'

    await doc.getElementById('test').fire('click')

    // Discovery never ran.
    expect(homebridge.requests.map(r => r.path)).toEqual(['/console-cert', '/test-connection'])
    expect(homebridge.toast.messages.map(m => m.kind)).not.toContain('success')
    expect(homebridge.toast.messages.at(-1)).toEqual({ kind: 'error', text: 'Could not save config.json: disk full' })
    expect(doc.getElementById('status').textContent).toBe('Could not save config.json: disk full')
    // The fields are back on what is on disk, not on what was typed.
    expect(doc.getElementById('host').value).toBe('10.0.0.1')
    expect(doc.getElementById('apiKey').value).toBe('k')
    // And nothing claims a certificate is pinned when storing it failed.
    expect(doc.getElementById('trust').textContent).not.toContain('pinned')
    expect(doc.getElementById('device-list').textContent).toBe('')
  })

  // `save()` recorded `savedConfig = config` AFTER its await — the newest
  // value, not the one that had just been accepted. With two writes in flight
  // the first one's success marked the SECOND, still-pending value as saved, so
  // when that one was refused the rollback restored the rejected value and the
  // next unrelated save wrote it to disk.
  it('does not mark a rejected value as saved when two writes overlap', async () => {
    const gates: (() => void)[] = []
    let update = 0
    const { doc, homebridge } = await start({
      holdUpdate: () => gates.length < 2 ? new Promise<void>(resolve => gates.push(resolve)) : undefined,
      rejectUpdate: () => (++update === 2 ? 'disk full' : undefined),
    })

    const maxStreams = doc.getElementById('maxStreams')
    const ffmpegPath = doc.getElementById('ffmpegPath')

    maxStreams.value = '4'
    const first = maxStreams.fire('change')
    ffmpegPath.value = '/usr/bin/ffmpeg'
    const second = ffmpegPath.fire('change')
    expect(gates).toHaveLength(2)

    // The first write lands, the second is refused — in that order.
    gates[0]?.()
    await first
    gates[1]?.()
    await second

    expect(homebridge.toast.messages.at(-1)).toEqual({ kind: 'error', text: 'Could not save config.json: disk full' })
    expect(ffmpegPath.value).toBe('')

    // The next, unrelated save must carry the ACCEPTED value and no trace of
    // the refused one.
    maxStreams.value = '6'
    await maxStreams.fire('change')
    expect(homebridge.stored()).toMatchObject({ maxStreams: 6 })
    expect(homebridge.stored()).not.toHaveProperty('ffmpegPath')
  })

  // `updatePluginConfig` only updates the runtime's in-memory copy;
  // `savePluginConfig` is what writes config.json, and it runs later inside the
  // debounce — long after `save()` returned `true`. Nothing can roll back by
  // then, so the failure has to be stated rather than swallowed.
  it('says the settings are not on disk when the config.json write fails', async () => {
    const { doc, homebridge, win } = await start({ rejectSave: () => 'read-only file system' })
    doc.getElementById('ffmpegPath').value = '/usr/bin/ffmpeg'
    await doc.getElementById('ffmpegPath').fire('change')

    // The runtime accepted it, so nothing rolled back and nothing complained.
    expect(homebridge.stored()).toMatchObject({ ffmpegPath: '/usr/bin/ffmpeg' })
    expect(homebridge.toast.messages).toEqual([])

    win.dispatch('pagehide')
    await new Promise(resolve => setTimeout(resolve, 0))

    const last = homebridge.toast.messages.at(-1)
    expect(last?.kind).toBe('error')
    expect(last?.text).toContain('read-only file system')
    expect(last?.text).toContain('not saved')
    // The aria-live line carries it too — a toast is gone on a timer.
    expect(doc.getElementById('status').textContent).toBe(last?.text)
  })
})

describe('the switch keeps its accessible name on the live page', () => {
  it('leaves the badge and reset button outside the control label', async () => {
    const { doc, homebridge } = await start()
    await doc.getElementById('test').fire('click')
    findAll(doc.getElementById('device-list'), el => el.dataset.id === 'cam1')[0]?.dispatch('click')

    const detail = doc.getElementById('device-detail')
    const hksv = byId(detail, 'cam1-hksv')
    hksv.checked = true
    await hksv.fire('change')
    expect(homebridge.stored()?.devices).toEqual({ cam1: { hksv: true } })

    const wrap = hksv.parent
    if (!wrap)
      throw new Error('the toggle has no wrapper')
    const caption = findAll(wrap, el => el.tagName === 'LABEL')[0]
    // The accessible name is the label's text and nothing else. It used to
    // read "HomeKit Secure Video restart required overridden reset".
    expect(caption?.textContent).toBe('HomeKit Secure Video')
    // All three are still ON the page, as siblings of the label.
    expect(wrap.textContent).toContain('restart required')
    expect(wrap.textContent).toContain('overridden')
    const reset = findAll(wrap, el => el.tagName === 'BUTTON')[0]
    expect(reset?.textContent).toBe('reset')
    expect(reset?.parent).toBe(wrap)
    // A button nested in a label is the invalid part.
    expect(findAll(caption!, el => el.tagName === 'BUTTON')).toHaveLength(0)
    // Bootstrap renders a switch only while these survive.
    expect(wrap.className.split(' ')).toEqual(expect.arrayContaining(['form-check', 'form-switch']))
    expect(hksv.className.split(' ')).toContain('form-check-input')

    // And reset really resets: the override goes, the switch follows.
    await reset?.fire('click')
    expect(hksv.checked).toBe(false)
    expect(homebridge.stored()?.devices).toEqual({})
  })

  // Unnesting them fixed the NAME and broke the DESCRIPTION: a screen-reader
  // user heard "Two-way audio" and was never told a restart was required, while
  // sighted users still saw the badge. Both properties, on the live page.
  it('describes the restart requirement and the override state to the control', async () => {
    const { doc } = await start()
    await doc.getElementById('test').fire('click')
    findAll(doc.getElementById('device-list'), el => el.dataset.id === 'cam1')[0]?.dispatch('click')

    const detail = doc.getElementById('device-detail')
    const talkback = byId(detail, 'cam1-talkback')
    const wrap = talkback.parent
    if (!wrap)
      throw new Error('the toggle has no wrapper')

    // The name is still the label and nothing else.
    expect(findAll(wrap, el => el.tagName === 'LABEL')[0]?.textContent).toBe('Two-way audio')

    // Resolved against the page: an id pointing at no element describes nothing.
    const description = () => (talkback.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .filter(Boolean)
      .map(id => byId(detail, id).textContent)

    expect(description()).toContain('restart required')
    expect(description()).toContain('default')

    talkback.checked = true
    await talkback.fire('change')
    expect(description()).toContain('restart required')
    expect(description()).toContain('overridden')
    // Rebuilding the badge must not leave a dangling id behind either — byId
    // above throws for one, and the list stays exactly two entries long.
    expect(description()).toHaveLength(2)
  })
})

describe('pending writes are flushed on the way out', () => {
  it('flushes the debounced disk write on pagehide', async () => {
    const { doc, homebridge, win } = await start()
    doc.getElementById('ffmpegPath').value = '/usr/bin/ffmpeg'
    await doc.getElementById('ffmpegPath').fire('change')
    // Still inside the one-second debounce window.
    expect(homebridge.saved()).toBe(0)

    win.dispatch('pagehide')
    expect(homebridge.saved()).toBe(1)
  })

  // The other handler, and the one that actually fires when the settings modal
  // is closed rather than the whole page unloaded.
  it('flushes the debounced disk write when the page is hidden', async () => {
    const { doc, homebridge } = await start()
    doc.getElementById('ffmpegPath').value = '/usr/bin/ffmpeg'
    await doc.getElementById('ffmpegPath').fire('change')
    expect(homebridge.saved()).toBe(0)

    // Still visible: nothing to flush, or every tab switch would write.
    doc.root.dispatch('visibilitychange')
    expect(homebridge.saved()).toBe(0)

    doc.visibilityState = 'hidden'
    doc.root.dispatch('visibilitychange')
    expect(homebridge.saved()).toBe(1)
  })
})

// The filter is wired through the `oninput` PROPERTY, which the fake never
// fired — so filtering, the one thing the device list does beyond rendering,
// was untested through the page.
describe('the device filter', () => {
  it('hides the rows that do not match what was typed', async () => {
    const { doc } = await start()
    await doc.getElementById('test').fire('click')

    const rows = () => findAll(doc.getElementById('device-list'), el => Boolean(el.dataset.id))
    expect(rows().filter(row => row.style.display !== 'none').map(row => row.textContent)).toEqual(['Front Door', 'Ding Dong'])

    const filter = doc.getElementById('device-filter')
    filter.value = 'ding'
    filter.dispatch('input')

    expect(rows().filter(row => row.style.display !== 'none').map(row => row.textContent)).toEqual(['Ding Dong'])

    filter.value = ''
    filter.dispatch('input')
    expect(rows().filter(row => row.style.display !== 'none')).toHaveLength(2)
  })
})

describe('discovered device cache', () => {
  it('persists the discovered devices into the stored config after Test Connection', async () => {
    const { doc, homebridge } = await start()
    await doc.getElementById('test').fire('click')

    const stored = homebridge.stored() as Record<string, unknown>
    expect(stored).toBeDefined()
    expect(stored.discoveredDevices).toEqual([CAMERA, CHIME])
  })

  it('renders the device list from the cache on load without a /discover request', async () => {
    // Build a homebridge fake that already has cached devices in the config.
    const cachedDevices = [CAMERA, CHIME]
    const doc = makePage()
    const win = new FakeElement('window')
    const requests: { path: string, payload: Record<string, unknown> }[] = []
    const updates: Record<string, unknown>[] = []
    let saves = 0
    const homebridge = {
      toast: new FakeToast(),
      requests,
      updates,
      saved: () => saves,
      stored: () => updates.at(-1),
      getPluginConfig: async () => [{ platform: 'UniFiProtect', name: 'UniFi Protect', host: '10.0.0.1', apiKey: 'k', discoveredDevices: cachedDevices }],
      updatePluginConfig: async ([next]: [Record<string, unknown>]) => { updates.push(structuredClone(next)) },
      savePluginConfig: async () => { saves++ },
      request: async (path: string, payload: Record<string, unknown>) => {
        requests.push({ path, payload })
        if (path === '/console-cert')
          return FIRST_SIGHT
        if (path === '/test-connection')
          return { nvrName: 'Dream Machine', version: '5.0.0' }
        return { devices: [CAMERA, CHIME] }
      },
      fixScrollHeight: () => {},
    }

    await startUi(doc, homebridge, win)

    // The device list must be populated from the cache — no /discover request.
    const discoverRequests = requests.filter(r => r.path === '/discover')
    expect(discoverRequests).toHaveLength(0)

    const rows = findAll(doc.getElementById('device-list'), el => Boolean(el.dataset.id))
    expect(rows.map(row => row.textContent)).toEqual(['Front Door', 'Ding Dong'])
  })
})
