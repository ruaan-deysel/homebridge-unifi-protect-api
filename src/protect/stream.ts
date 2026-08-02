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

    // A clear() during the request means the caller asked for these to be
    // forgotten; a late answer must not put one straight back.
    if (generation === this.generation)
      this.cache.set(key, { url, at: performance.now() })
    return url
  }

  clear(): void {
    this.cache.clear()
    this.inFlight.clear()
    this.generation++
  }
}
