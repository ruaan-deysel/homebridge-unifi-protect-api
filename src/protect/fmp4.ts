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
/**
 * Upper bound on one box, so a corrupt length cannot be accumulated towards.
 * The `MIN_BOX` guard stops the loop spinning but not the buffering: a length of
 * 0xFFFFFFFF keeps `pending.length < length` true while every chunk is
 * concatenated on, reaching 4 GB before anything throws.
 *
 * 64 MiB cannot reject a legitimate fragment: measured fragments are ~250 KB at
 * 4 s on the high substream, so this is roughly 250x the real thing — a single
 * 4 s fragment would have to arrive at 134 Mbit/s to reach it.
 */
const MAX_BOX = 64 * 1024 * 1024

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
      // A length below the header size cannot advance the cursor (the loop
      // would spin forever), and one above MAX_BOX can only be corruption the
      // splitter would otherwise buffer towards for gigabytes.
      //
      // Sizes 1 and 0 are legal ISO-BMFF — 64-bit `largesize`, and "box runs to
      // end of file" — and are rejected here rather than implemented: neither
      // can occur in a 4 s fragmented-MP4 stream from this encoder, and both
      // would be dead code nobody could exercise.
      if (length < MIN_BOX || length > MAX_BOX)
        throw new Error(`refusing a box length of ${length} (64-bit and to-end-of-file box sizes are not supported)`)
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
