import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { routeEvent } from '../src/accessories/router.js'

const load = (n: string) => JSON.parse(readFileSync(`test/fixtures/events/${n}.json`, 'utf8'))

describe('routeEvent', () => {
  it('never throws on malformed input', () => {
    for (const bad of [null, undefined, 0, 'x', [], {}, { item: null }, { item: { type: 5 } }, { type: 'add' }])
      expect(() => routeEvent(bad)).not.toThrow()
  })

  it('returns null for frames it does not handle', () => {
    expect(routeEvent({ type: 'add', item: { type: 'somethingNew', device: 'd', id: 'e' } })).toBeNull()
  })

  it('maps a real motion event to the motion subtype', () => {
    const frame = load('motion').find((f: { payload: { type: string } }) => f.payload.type === 'add')
    const routed = routeEvent(frame.payload)
    expect(routed).toMatchObject({ subtypes: ['motion'], phase: 'start', stateless: false })
    expect(routed!.deviceId).toBe(frame.payload.item.device)
    // Real hardware never sends an explicit `end: null` on an in-progress
    // event — the key is simply absent. Confirm the fixture agrees.
    expect(Object.hasOwn(frame.payload.item, 'end')).toBe(false)
  })

  it('resolves a real motion event to its end phase on the matching update frame', () => {
    const frames = load('motion') as { payload: { type: string, item: { id: string, end?: number } } }[]
    const addFrame = frames.find(f => f.payload.type === 'add')!
    const updateFrame = frames.find(f =>
      f.payload.type === 'update' && f.payload.item.id === addFrame.payload.item.id && typeof f.payload.item.end === 'number',
    )!
    const routed = routeEvent(updateFrame.payload)
    expect(routed).toMatchObject({ eventId: addFrame.payload.item.id, phase: 'end' })
  })

  it('maps a real ring event to the ring subtype and marks it stateless', () => {
    const frame = load('ring').find((f: { payload: { type: string } }) => f.payload.type === 'add')
    const routed = routeEvent(frame.payload)
    expect(routed).toMatchObject({ subtypes: ['ring'], phase: 'start', stateless: true })
  })

  it('maps a real smartDetectZone (person) event to detect-person', () => {
    const frame = load('smart-detect').find((f: { payload: { type: string } }) => f.payload.type === 'add')
    const routed = routeEvent(frame.payload)
    expect(routed).toMatchObject({ subtypes: ['detect-person'], phase: 'start' })
    // smartDetectTypes is observed only on smartDetectZone/Line/LoiterZone items,
    // never on motion or ring.
    expect(Array.isArray(frame.payload.item.smartDetectTypes)).toBe(true)
  })

  it('reports the same end phase for repeated end frames without throwing', () => {
    // Task 0 captured end frames delivered up to 3x with an identical `end`
    // value for the same event id. The router is stateless, so repeats must
    // just produce the same phase each time — dedup is the tracker's job.
    const frames = load('end-frames') as { payload: unknown }[]
    for (const frame of frames) {
      expect(() => routeEvent(frame.payload)).not.toThrow()
      const routed = routeEvent(frame.payload)
      expect(routed?.phase).toBe('end')
    }
  })

  it('maps every smart-detect channel to per-type subtypes', () => {
    for (const type of ['smartDetectZone', 'smartDetectLine', 'smartDetectLoiterZone']) {
      const routed = routeEvent({
        type: 'add',
        item: { id: 'e1', device: 'cam1', type, start: 1, smartDetectTypes: ['person', 'vehicle'] },
      })
      expect(routed?.subtypes, type).toEqual(['detect-person', 'detect-vehicle'])
    }
  })

  it('maps only smoke and CO from audio detection (synthesized: smartAudioDetect never fired during capture, audio detection is disabled on all cameras)', () => {
    const routed = routeEvent({
      type: 'add',
      item: {
        id: 'e2',
        device: 'cam1',
        type: 'smartAudioDetect',
        start: 1,
        // Shape derived from the real captured person smartDetectZone item,
        // with type/smartDetectTypes swapped in — no smartAudioDetect frame
        // was ever observed on real hardware.
        smartDetectTypes: ['alrmSmoke', 'alrmBark', 'alrmCmonx', 'alrmCarHorn'],
      },
    })
    expect(routed?.subtypes).toEqual(['audio-alrmSmoke', 'audio-alrmCmonx'])
  })

  it('drops an unknown detection type without throwing', () => {
    const routed = routeEvent({
      type: 'add',
      item: { id: 'e3', device: 'cam1', type: 'smartDetectZone', start: 1, smartDetectTypes: ['person', 'teleporter'] },
    })
    expect(routed?.subtypes).toEqual(['detect-person'])
  })

  it('returns null when every detection type is unknown', () => {
    expect(routeEvent({
      type: 'add',
      item: { id: 'e4', device: 'cam1', type: 'smartDetectZone', start: 1, smartDetectTypes: ['teleporter'] },
    })).toBeNull()
  })

  it('marks a ring as stateless', () => {
    const routed = routeEvent({ type: 'add', item: { id: 'e5', device: 'cam1', type: 'ring', start: 1 } })
    expect(routed).toMatchObject({ subtypes: ['ring'], stateless: true })
  })

  it('routes vehicle and animal detections (synthesized: only person ever fired during capture)', () => {
    // Derived from the real captured smartDetectZone person item, swapping
    // only smartDetectTypes — vehicle/animal channels never fired on the five
    // cameras during Task 0 capture.
    const routed = routeEvent({
      type: 'add',
      item: { id: 'e7', device: '3df76e6abedbeab796e616d9', type: 'smartDetectZone', start: 1785563286381, smartDetectTypes: ['vehicle', 'animal'] },
    })
    expect(routed?.subtypes).toEqual(['detect-vehicle', 'detect-animal'])
  })

  it('distinguishes the three phases', () => {
    const base = { id: 'e6', device: 'cam1', type: 'motion', start: 1 }
    expect(routeEvent({ type: 'add', item: { ...base } })?.phase).toBe('start')
    expect(routeEvent({ type: 'update', item: { ...base, end: 2 } })?.phase).toBe('end')
    // An `add` that already carries an end is a detection too short to span two frames.
    expect(routeEvent({ type: 'add', item: { ...base, end: 2 } })?.phase).toBe('momentary')
  })

  it('treats an explicit end: null the same as an absent key, defensively', () => {
    // Not observed on real hardware (Task 0 saw zero explicit nulls across 33
    // frames), but the router must not crash or misclassify if a future
    // firmware ever sends one.
    const routed = routeEvent({ type: 'add', item: { id: 'e8', device: 'cam1', type: 'motion', start: 1, end: null } })
    expect(routed?.phase).toBe('start')
  })

  it('never lets event ids be mistaken for a shape check: ring ids are 24-hex device-id-shaped, motion/smartDetect ids are UUIDs', () => {
    const ringFrame = load('ring').find((f: { payload: { type: string } }) => f.payload.type === 'add')
    const motionFrame = load('motion').find((f: { payload: { type: string } }) => f.payload.type === 'add')
    expect(ringFrame.payload.item.id).toHaveLength(24)
    expect(motionFrame.payload.item.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(routeEvent(ringFrame.payload)?.eventId).toBe(ringFrame.payload.item.id)
    expect(routeEvent(motionFrame.payload)?.eventId).toBe(motionFrame.payload.item.id)
  })
})
