import { describe, expect, it } from 'vitest'
import { selectQuality } from '../src/accessories/quality.js'

describe('selectQuality', () => {
  // Resolutions measured off the real console on 2026-08-01:
  // high 2688x1512, medium 1280x720, low 640x360 — all HEVC 30fps.
  it('uses the low substream for thumbnail-sized requests', () => {
    expect(selectQuality(320, 240)).toBe('low')
    expect(selectQuality(640, 360)).toBe('low')
  })

  it('uses medium for 720p, which needs no scaling at all', () => {
    expect(selectQuality(1280, 720)).toBe('medium')
  })

  it('uses high for anything larger', () => {
    expect(selectQuality(1920, 1080)).toBe('high')
    expect(selectQuality(2688, 1512)).toBe('high')
  })

  it('lets an explicit override win', () => {
    expect(selectQuality(320, 240, 'high')).toBe('high')
    expect(selectQuality(1920, 1080, 'low')).toBe('low')
  })

  it('treats auto as no override', () => {
    expect(selectQuality(1280, 720, 'auto')).toBe('medium')
  })

  it('ignores an unrecognised override instead of throwing', () => {
    expect(selectQuality(1280, 720, 'ludicrous' as never)).toBe('medium')
  })

  // A request wider than 720p but shorter than it must not be mistaken for 720p.
  it('requires BOTH dimensions to fit a tier', () => {
    expect(selectQuality(1920, 360)).toBe('high')
  })
})
