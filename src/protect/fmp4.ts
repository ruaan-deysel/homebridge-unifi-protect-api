import { Buffer } from 'node:buffer'

/**
 * ffmpeg writes fragmented MP4 to stdout as a flat byte stream; HomeKit wants
 * it as discrete pieces — the initialization segment first, then whole
 * fragments, each starting on a keyframe.
 *
 * Every fragment starts on a keyframe by construction, because the encoder is
 * invoked with `-movflags frag_keyframe`. This splitter therefore does no
 * keyframe detection of its own: doing so would mean parsing sample flags to
 * re-derive something the muxer already guarantees.
 */
export type Fmp4Piece = 'init' | 'fragment'

const MIN_BOX = 8

export class Fmp4Splitter {
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private init: Buffer[] = []
  private fragment: Buffer[] = []

  constructor(private readonly emit: (kind: Fmp4Piece, data: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    for (;;) {
      if (this.pending.length < MIN_BOX)
        return
      const length = this.pending.readUInt32BE(0)
      // A length below the header size cannot advance the cursor: without this
      // the loop would spin forever on a corrupt stream.
      if (length < MIN_BOX)
        throw new Error(`refusing a box length of ${length}`)
      if (this.pending.length < length)
        return
      const type = this.pending.toString('latin1', 4, 8)
      const box = this.pending.subarray(0, length)
      this.pending = this.pending.subarray(length)
      this.take(type, box)
    }
  }

  private take(type: string, box: Buffer): void {
    if (type === 'ftyp' || type === 'moov') {
      this.init.push(box)
      if (type === 'moov') {
        this.emit('init', Buffer.concat(this.init))
        this.init = []
      }
      return
    }
    if (type === 'moof') {
      this.fragment = [box]
      return
    }
    if (type === 'mdat' && this.fragment.length > 0) {
      this.fragment.push(box)
      this.emit('fragment', Buffer.concat(this.fragment))
      this.fragment = []
    }
  }
}
