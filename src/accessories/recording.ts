import type { Buffer } from 'node:buffer'
import type { Fmp4Piece } from '../protect/fmp4.js'

/**
 * Bounded by COUNT, not by time: a stalled or slow stream must not be able to
 * grow this without limit. At the 4000 ms fragment length HomeKit negotiates,
 * 16 fragments is about 64 s — far more than the 4000 ms `prebufferLength`
 * requires, with room for fragments that run long because a keyframe arrived
 * late. Measured at roughly 250 KB per fragment on the high substream, so
 * about 4 MB per recording camera.
 */
export const PREBUFFER_FRAGMENTS = 16

/**
 * Holds the most recent fragments so a HKSV recording can start from before
 * the motion that triggered it.
 */
export class PrebufferRing {
  private init?: Buffer
  private fragments: Buffer[] = []

  accept(kind: Fmp4Piece, data: Buffer): void {
    if (kind === 'init') {
      this.init = data
      return
    }
    this.fragments.push(data)
    if (this.fragments.length > PREBUFFER_FRAGMENTS)
      this.fragments.shift()
  }

  /**
   * Undefined until the init segment has arrived: HomeKit cannot decode a
   * fragment without it, so half an answer is worse than none.
   */
  snapshot(): { init: Buffer, fragments: Buffer[] } | undefined {
    if (!this.init)
      return undefined
    return { fragments: [...this.fragments], init: this.init }
  }

  /** Keeps the init segment — it describes the stream, not a moment in it. */
  reset(): void {
    this.fragments = []
  }
}
