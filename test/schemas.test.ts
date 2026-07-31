import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cameraSchema, chimeSchema, existingRtspsStreamsSchema, liveviewSchema, nvrSchema } from '../src/protect/schemas.js'

const load = (n: string) => JSON.parse(readFileSync(`test/fixtures/${n}.json`, 'utf8'))

describe('generated schemas parse real hardware payloads', () => {
  it('parses every camera', () => {
    for (const camera of load('cameras'))
      expect(cameraSchema.safeParse(camera).success).toBe(true)
  })

  it('parses chimes, liveviews and the nvr', () => {
    for (const chime of load('chimes'))
      expect(chimeSchema.safeParse(chime).success).toBe(true)
    for (const view of load('liveviews'))
      expect(liveviewSchema.safeParse(view).success).toBe(true)
    expect(nvrSchema.safeParse(load('nvrs')).success).toBe(true)
  })

  it('parses the rtsps stream response', () => {
    expect(existingRtspsStreamsSchema.safeParse(load('rtsps-stream')).success).toBe(true)
  })

  it('keeps redacted cross-references consistent', () => {
    // Redaction is hash-based, so chimes[].cameraIds must still resolve to a
    // camera id. If this fails the fixtures were redacted inconsistently and
    // any reconciliation test built on them is meaningless.
    const ids = new Set(load('cameras').map((c: { id: string }) => c.id))
    for (const chime of load('chimes')) {
      for (const id of chime.cameraIds) expect(ids.has(id)).toBe(true)
    }
  })

  it('preserves unknown fields so a firmware update cannot silently drop data', () => {
    const [camera] = load('cameras')
    const parsed = cameraSchema.parse({ ...camera, someFutureField: 42 })
    expect((parsed as Record<string, unknown>).someFutureField).toBe(42)
  })

  it('accepts an unknown enum member without throwing', () => {
    // A new videoMode in a future firmware must degrade, not crash the plugin.
    const [camera] = load('cameras')
    const result = cameraSchema.safeParse({ ...camera, videoMode: 'someFutureMode' })
    expect(result.success).toBe(false) // strict at the schema layer...
    // ...and Task 3 is responsible for turning this into a warning, not a throw.
  })
})
