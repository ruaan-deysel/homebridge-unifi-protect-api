import type { Quality } from '../accessories/quality.js'
import type { ProtectClient } from './client.js'

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

  constructor(
    private readonly client: Pick<ProtectClient, 'getRtspsStream' | 'createRtspsStream'>,
    /** Well under Protect's own stream lifetime, so a stale URL is never handed to ffmpeg. */
    private readonly ttlMs = 5 * 60_000,
  ) {}

  async get(deviceId: string, quality: Quality): Promise<string> {
    const key = `${deviceId}:${quality}`
    const hit = this.cache.get(key)
    // performance.now(), never Date.now(): this hardware NTP-steps its wall
    // clock after a power cut, which would make a fresh entry look ancient.
    if (hit && performance.now() - hit.at < this.ttlMs)
      return hit.url

    const existing = await this.client.getRtspsStream(deviceId)
    let url = existing[quality] ?? undefined
    if (!url) {
      const created = await this.client.createRtspsStream(deviceId, [quality])
      url = created[quality]
    }
    if (!url)
      throw new Error(`The console did not provide a ${quality} stream for camera ${deviceId}.`)

    this.cache.set(key, { url, at: performance.now() })
    return url
  }

  clear(): void {
    this.cache.clear()
  }
}
