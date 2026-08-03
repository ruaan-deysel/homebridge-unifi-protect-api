import { inspect } from 'node:util'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamUrls } from '../src/protect/stream.js'

const URL_HIGH = 'rtsps://192.0.2.1:7441/abc?token=SENTINEL-TOKEN'

function makeClient(existing: Record<string, string> = {}) {
  return {
    getRtspsStream: vi.fn(async () => ({ ...existing })),
    createRtspsStream: vi.fn(async () => ({ high: URL_HIGH })),
  }
}

describe('streamUrls', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['performance'] }))

  it('returns an existing url without creating one', async () => {
    const client = makeClient({ high: URL_HIGH })
    const urls = new StreamUrls(client as never)
    expect(await urls.get('cam1', 'high')).toBe(URL_HIGH)
    expect(client.createRtspsStream).not.toHaveBeenCalled()
  })

  it('creates the stream when the quality is absent', async () => {
    const client = makeClient({})
    const urls = new StreamUrls(client as never)
    expect(await urls.get('cam1', 'high')).toBe(URL_HIGH)
    expect(client.createRtspsStream).toHaveBeenCalledWith('cam1', ['high'])
  })

  it('caches within the ttl', async () => {
    const client = makeClient({ high: URL_HIGH })
    const urls = new StreamUrls(client as never)
    await urls.get('cam1', 'high')
    await urls.get('cam1', 'high')
    expect(client.getRtspsStream).toHaveBeenCalledTimes(1)
  })

  it('re-requests after the ttl expires', async () => {
    const client = makeClient({ high: URL_HIGH })
    const urls = new StreamUrls(client as never, 60_000)
    await urls.get('cam1', 'high')
    vi.advanceTimersByTime(60_001)
    await urls.get('cam1', 'high')
    expect(client.getRtspsStream).toHaveBeenCalledTimes(2)
  })

  it('clear() drops the cache', async () => {
    const client = makeClient({ high: URL_HIGH })
    const urls = new StreamUrls(client as never)
    await urls.get('cam1', 'high')
    urls.clear()
    await urls.get('cam1', 'high')
    expect(client.getRtspsStream).toHaveBeenCalledTimes(2)
  })

  // Entries carry credential-bearing RTSPS URLs and the cache lives as long as
  // the process, so a removed camera has to be dropped by id — a TTL miss only
  // refetches the entry, it never removes it.
  it('evict() drops every quality of one camera and leaves the others alone', async () => {
    const client = makeClient({ high: URL_HIGH, low: URL_HIGH })
    const urls = new StreamUrls(client as never)
    await Promise.all([urls.get('cam1', 'high'), urls.get('cam1', 'low'), urls.get('cam2', 'high')])
    expect(client.getRtspsStream).toHaveBeenCalledTimes(3)

    urls.evict('cam1')

    // cam2 is still cached: eviction is per camera, and live view shares this.
    await urls.get('cam2', 'high')
    expect(client.getRtspsStream).toHaveBeenCalledTimes(3)
    // Both of cam1's are gone, not just the one that happened to be first.
    await Promise.all([urls.get('cam1', 'high'), urls.get('cam1', 'low')])
    expect(client.getRtspsStream).toHaveBeenCalledTimes(5)
  })

  // The key is `${deviceId}:${quality}`, so a prefix match must not reach a
  // camera whose id merely starts with the evicted one.
  it('evict() does not touch a camera whose id shares a prefix', async () => {
    const client = makeClient({ high: URL_HIGH })
    const urls = new StreamUrls(client as never)
    await Promise.all([urls.get('cam1', 'high'), urls.get('cam10', 'high')])
    urls.evict('cam1')
    await urls.get('cam10', 'high')
    expect(client.getRtspsStream).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent misses into one request per camera and quality', async () => {
    const client = makeClient({})
    const urls = new StreamUrls(client as never)
    const results = await Promise.all([
      urls.get('cam1', 'high'),
      urls.get('cam1', 'high'),
      urls.get('cam1', 'high'),
    ])
    expect(results).toEqual([URL_HIGH, URL_HIGH, URL_HIGH])
    // Without coalescing this is three creates: HomeKit opening a camera on
    // three devices at once is one Protect stream, not three.
    expect(client.getRtspsStream).toHaveBeenCalledTimes(1)
    expect(client.createRtspsStream).toHaveBeenCalledTimes(1)
  })

  it('keeps different qualities and different cameras independent', async () => {
    const client = {
      getRtspsStream: vi.fn(async () => ({ high: URL_HIGH, low: 'rtsps://192.0.2.1:7441/low?token=T' })),
      createRtspsStream: vi.fn(async () => ({})),
    }
    const urls = new StreamUrls(client as never)
    await Promise.all([urls.get('cam1', 'high'), urls.get('cam1', 'low'), urls.get('cam2', 'high')])
    expect(client.getRtspsStream).toHaveBeenCalledTimes(3)
  })

  it('does not let a request in flight over clear() repopulate the cache', async () => {
    let release = (): void => {}
    const parked = new Promise<void>((resolve) => {
      release = resolve
    })
    const client = {
      getRtspsStream: vi.fn(async () => {
        await parked
        return { high: URL_HIGH }
      }),
      createRtspsStream: vi.fn(async () => ({})),
    }
    const urls = new StreamUrls(client as never)
    const inFlight = urls.get('cam1', 'high')
    urls.clear()
    release()
    expect(await inFlight).toBe(URL_HIGH)

    // The stale answer must not have landed in the cache clear() just emptied.
    await urls.get('cam1', 'high')
    expect(client.getRtspsStream).toHaveBeenCalledTimes(2)
  })

  it('reports a client failure without re-throwing the error that carries the api key', async () => {
    const client = {
      getRtspsStream: vi.fn(async () => {
        // Exactly the shape the REST client produces: the credential hides in
        // `cause`, which is where util.inspect (what log.error uses) finds it.
        throw Object.assign(new Error('403 Forbidden'), { cause: { apiKey: 'SENTINEL-TOKEN' } })
      }),
      createRtspsStream: vi.fn(async () => ({})),
    }
    const urls = new StreamUrls(client as never)
    const error = await urls.get('cam1', 'high').then(() => undefined, (err: unknown) => err)
    expect(error).toBeInstanceOf(Error)
    // Positive first: a thrown-nothing would satisfy the negative assertion.
    expect((error as Error).message).toContain('403 Forbidden')
    expect(inspect(error, { depth: 10 })).not.toContain('SENTINEL-TOKEN')
  })

  it('reports a quality the console never provides without leaking anything', async () => {
    // The sentinel MUST enter the system (as the 'high' URL) so the negative
    // assertion below means something. Requesting 'low' — which is genuinely
    // unavailable — must never surface the 'high' URL sitting right next to
    // it in the same response, whether via the message, `cause`, or any other
    // enumerable property that `util.inspect` (what `log.error` uses) walks.
    const client = {
      getRtspsStream: vi.fn(async () => ({ high: URL_HIGH })),
      createRtspsStream: vi.fn(async () => ({})),
    }
    const urls = new StreamUrls(client as never)
    let error: unknown
    try {
      await urls.get('cam1', 'low')
    }
    catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/low/)
    expect(inspect(error, { depth: 10 })).not.toContain('SENTINEL-TOKEN')
  })
})
