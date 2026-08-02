import { readFileSync } from 'node:fs'
import { inspect } from 'node:util'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProtectNotFoundError } from '../src/protect/errors.js'
import { StreamUrls } from '../src/protect/stream.js'

const URL_HIGH = 'rtsps://192.0.2.1:7441/abc?token=SENTINEL-TOKEN'
const withPackage = JSON.parse(readFileSync('test/fixtures/package/rtsps-package.json', 'utf8')).body

/**
 * A camera WITHOUT a package lens does not return a body missing the key — the
 * console answers 404 (`NOT_FOUND`, entity "quality"), and `send()` turns that
 * into a rejected ProtectNotFoundError. Captured in rtsps-none.json.
 */
function notFound() {
  return new ProtectNotFoundError('POST /v1/cameras/x/rtsps-stream: not found (404)')
}

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

describe('hasPackageCamera', () => {
  it('is true when the console returns a package url', async () => {
    const client = { getRtspsStream: vi.fn(async () => ({})), createRtspsStream: vi.fn(async () => withPackage) }
    const urls = new StreamUrls(client as never)
    expect(await urls.hasPackageCamera('cam1')).toBe(true)
  })

  // The real signal for "no package lens" is a 404, not an absent key.
  it('is false when the console 404s the package quality', async () => {
    const client = {
      getRtspsStream: vi.fn(async () => ({})),
      createRtspsStream: vi.fn(async () => { throw notFound() }),
    }
    const urls = new StreamUrls(client as never)
    expect(await urls.hasPackageCamera('cam1')).toBe(false)
  })

  // Belt and braces: a 200 that somehow omits the key must also read as false.
  it('is false when a 200 omits the package key', async () => {
    const client = { getRtspsStream: vi.fn(async () => ({})), createRtspsStream: vi.fn(async () => ({})) }
    const urls = new StreamUrls(client as never)
    expect(await urls.hasPackageCamera('cam1')).toBe(false)
  })

  it('is false when the request throws, and swallows the error', async () => {
    const client = {
      getRtspsStream: vi.fn(async () => ({})),
      createRtspsStream: vi.fn(async () => { throw Object.assign(new Error('boom'), { cause: { apiKey: 'SENTINEL-KEY' } }) }),
    }
    const urls = new StreamUrls(client as never)
    await expect(urls.hasPackageCamera('cam1')).resolves.toBe(false)
  })

  it('caches the answer per device', async () => {
    const client = { getRtspsStream: vi.fn(async () => ({})), createRtspsStream: vi.fn(async () => withPackage) }
    const urls = new StreamUrls(client as never)
    await urls.hasPackageCamera('cam1')
    await urls.hasPackageCamera('cam1')
    expect(client.createRtspsStream).toHaveBeenCalledTimes(1)
  })

  it('caches per device, not globally', async () => {
    const client = {
      getRtspsStream: vi.fn(async () => ({})),
      createRtspsStream: vi.fn(async (id: string) => {
        if (id !== 'cam1')
          throw notFound()
        return withPackage
      }),
    }
    const urls = new StreamUrls(client as never)
    expect(await urls.hasPackageCamera('cam1')).toBe(true)
    expect(await urls.hasPackageCamera('cam2')).toBe(false)
  })
})
