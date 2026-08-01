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

  it('reports a quality the console never provides without leaking anything', async () => {
    const client = {
      getRtspsStream: vi.fn(async () => ({})),
      createRtspsStream: vi.fn(async () => ({})),
    }
    const urls = new StreamUrls(client as never)
    await expect(urls.get('cam1', 'low')).rejects.toThrow(/low/)
    await expect(urls.get('cam1', 'low')).rejects.not.toThrow(/SENTINEL-TOKEN/)
  })
})
