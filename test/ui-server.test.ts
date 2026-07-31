import { describe, expect, it, vi } from 'vitest'
import { discoverRequest, testConnectionRequest } from '../homebridge-ui/server.js'

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('testConnectionRequest', () => {
  it('returns the protect version and nvr name', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/meta/info') ? ok({ applicationVersion: '7.1.87' }) : ok({ id: 'n1', name: 'UDM-Pro' })) as never

    const result = await testConnectionRequest({ host: '10.0.0.1', apiKey: 'k' }, { fetchImpl })

    expect(result).toEqual({ version: '7.1.87', nvrName: 'UDM-Pro' })
  })

  it('explains a rejected api key', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 })) as never
    await expect(testConnectionRequest({ host: '10.0.0.1', apiKey: 'bad' }, { fetchImpl })).rejects.toThrow(/API key/i)
  })

  it('explains an unreachable host differently from a bad key', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError('fetch failed'))) as never
    await expect(testConnectionRequest({ host: '10.0.0.9', apiKey: 'k' }, { fetchImpl })).rejects.toThrow(/could not reach/i)
  })

  it('rejects an empty host without touching the network', async () => {
    const fetchImpl = vi.fn() as never
    await expect(testConnectionRequest({ host: '', apiKey: 'k' }, { fetchImpl })).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('discoverRequest', () => {
  it('returns capability flags so the UI cannot offer impossible settings', async () => {
    const cameras = [{
      id: 'cam1',
      name: 'Doorbell',
      modelKey: 'camera',
      hasPackageCamera: true,
      featureFlags: { hasSpeaker: true, hasLedStatus: true, smartDetectTypes: ['person', 'package'] },
    }]
    const fetchImpl = vi.fn(async (url: string) => ok(url.endsWith('/cameras') ? cameras : [])) as never

    const result = await discoverRequest({ host: '10.0.0.1', apiKey: 'k' }, { fetchImpl })

    expect(result.devices[0]).toEqual({
      id: 'cam1',
      name: 'Doorbell',
      type: 'camera',
      hasSpeaker: true,
      hasLedStatus: true,
      hasPackageCamera: true,
      smartDetectTypes: ['person', 'package'],
    })
  })
})
