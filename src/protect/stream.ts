import type { Quality } from '../accessories/quality.js'
import type { ProtectClient } from './client.js'
import { errorMessage } from './errors.js'

interface Entry { url: string, at: number }

/**
 * Protect returns `null` for a quality until a stream has been created with
 * POST /cameras/{id}/rtsps-stream, so a missing URL means "not created yet",
 * not "unsupported".
 *
 * The returned URLs carry an auth token. They are credentials: never log one,
 * never put one in an Error message.
 */
export class StreamUrls {
  private readonly cache = new Map<string, Entry>()
  /** One request per key at a time; the rest join it. */
  private readonly inFlight = new Map<string, Promise<string>>()
  /** Bumped by clear(), so a request started before it cannot repopulate the cache. */
  private generation = 0
  /**
   * Per-key counter, bumped by evict(). Same job as `generation` but for one
   * camera, because evict() must not make every OTHER camera's in-flight fetch
   * skip the cache — that is live view's path.
   *
   * ponytail: never pruned. One small integer per camera per quality, bounded
   * by the console's device count, and dropping an entry is what would let a
   * fetch that started before the evict look current again.
   */
  private readonly keyGenerations = new Map<string, number>()

  constructor(
    private readonly client: Pick<ProtectClient, 'getRtspsStream' | 'createRtspsStream'>,
    /** Well under Protect's own stream lifetime, so a stale URL is never handed to ffmpeg. */
    private readonly ttlMs = 5 * 60_000,
  ) {}

  async get(deviceId: string, quality: Quality | 'package'): Promise<string> {
    const key = `${deviceId}:${quality}`
    const hit = this.cache.get(key)
    // performance.now(), never Date.now(): this hardware NTP-steps its wall
    // clock after a power cut, which would make a fresh entry look ancient.
    if (hit && performance.now() - hit.at < this.ttlMs)
      return hit.url

    // Coalesced: HomeKit starting several viewers on one camera at once would
    // otherwise issue N `createRtspsStream` calls against the console for the
    // same substream.
    const joined = this.inFlight.get(key)
    if (joined)
      return joined

    const promise = this.fetch(deviceId, quality, key).finally(() => {
      if (this.inFlight.get(key) === promise)
        this.inFlight.delete(key)
    })
    this.inFlight.set(key, promise)
    return promise
  }

  private async fetch(deviceId: string, quality: Quality | 'package', key: string): Promise<string> {
    const generation = this.generation
    const keyGeneration = this.keyGenerations.get(key) ?? 0
    let url: string | undefined
    try {
      const existing = await this.client.getRtspsStream(deviceId)
      url = existing[quality] ?? undefined
      if (!url) {
        const created = await this.client.createRtspsStream(deviceId, [quality])
        url = created[quality]
      }
    }
    catch (error) {
      // A fresh Error carrying the MESSAGE only. Rethrowing the client's own
      // error (or setting it as `cause`) hands util.inspect a request context
      // that has printed the API key out of this repo before.
      throw new Error(`Could not get the ${quality} stream URL for camera ${deviceId}: ${errorMessage(error)}`)
    }
    if (!url)
      throw new Error(`The console did not provide a ${quality} stream for camera ${deviceId}.`)

    // A clear() or an evict() during the request means the caller asked for
    // these to be forgotten; a late answer must not put one straight back. The
    // URL is still returned to whoever is waiting on it — they asked before the
    // eviction — it just is not remembered.
    if (generation === this.generation && (this.keyGenerations.get(key) ?? 0) === keyGeneration)
      this.cache.set(key, { url, at: performance.now() })
    return url
  }

  /**
   * Forgets one camera's URLs, for when the accessory is removed. The cache
   * lives as long as the process and its entries carry credentials, so without
   * this a console churning cameras leaves a credential-bearing URL per camera
   * per quality behind forever — a TTL miss does not drop the entry, it only
   * refetches it.
   *
   * A fetch already in flight for this camera is left running and left joinable
   * — dropping it from `inFlight` would only make a concurrent `get` open a
   * SECOND stream against the console — but its per-key generation is bumped,
   * so when it answers it will not write the entry back.
   *
   * A package accessory shares its parent's device id, so removing one also
   * drops the parent's entries. That costs a refetch on the next stream,
   * nothing more.
   */
  evict(deviceId: string): void {
    const prefix = `${deviceId}:`
    for (const key of [...this.cache.keys(), ...this.inFlight.keys()]) {
      if (!key.startsWith(prefix))
        continue
      this.cache.delete(key)
      this.keyGenerations.set(key, (this.keyGenerations.get(key) ?? 0) + 1)
    }
  }

  clear(): void {
    this.cache.clear()
    this.inFlight.clear()
    this.generation++
  }
}
