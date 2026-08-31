import { describe, expect, it, vi } from 'vitest'
import { consoleCertRequest, discoverRequest, testConnectionRequest } from '../homebridge-ui/server.js'
import { fingerprintOf } from '../src/protect/cert.js'
import { makeSelfSigned } from './support/tls.js'

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** Real certificates: fingerprints of made-up strings would collide trivially. */
const CERT_A = makeSelfSigned('console-a').cert
const CERT_B = makeSelfSigned('console-b').cert

/** Every handler that carries the key needs one — see the fail-closed test. */
const creds = { host: '10.0.0.1', apiKey: 'k', consoleCert: CERT_A }

describe('testConnectionRequest', () => {
  it('returns the protect version and nvr name', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/meta/info') ? ok({ applicationVersion: '7.2.105' }) : ok({ id: 'n1', name: 'UDM-Pro' })) as never

    const result = await testConnectionRequest(creds, { fetchImpl })

    expect(result).toEqual({ version: '7.2.105', nvrName: 'UDM-Pro' })
  })

  it('pins every request to the trusted certificate', async () => {
    const fetchImpl = vi.fn(async () => ok({ applicationVersion: '7.2.105' })) as never

    await testConnectionRequest(creds, { fetchImpl })

    for (const [, init] of (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls)
      expect(init.consoleCert).toBe(CERT_A)
  })

  // The UI's half of the fail-closed rule: the key is not sent to a console
  // whose certificate has not been checked yet.
  it('refuses to send the api key before a certificate has been trusted', async () => {
    const fetchImpl = vi.fn() as never
    await expect(testConnectionRequest({ host: '10.0.0.1', apiKey: 'k' }, { fetchImpl }))
      .rejects
      .toThrow(/certificate has not been trusted/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('explains a rejected api key', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 })) as never
    await expect(testConnectionRequest({ ...creds, apiKey: 'bad' }, { fetchImpl })).rejects.toThrow(/API key/i)
  })

  it('explains an unreachable host differently from a bad key', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError('fetch failed'))) as never
    await expect(testConnectionRequest({ ...creds, host: '10.0.0.9' }, { fetchImpl })).rejects.toThrow(/could not reach/i)
  })

  it('blames the certificate, not the network, when the pin rejects the peer', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(Object.assign(new Error('nope'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }))) as never
    await expect(testConnectionRequest(creds, { fetchImpl })).rejects.toThrow(/certificate this plugin does not trust/i)
  })

  it('rejects an empty host without touching the network', async () => {
    const fetchImpl = vi.fn() as never
    await expect(testConnectionRequest({ ...creds, host: '' }, { fetchImpl })).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('consoleCertRequest', () => {
  const readCert = (pem: string) => vi.fn(async () => ({ pem, fingerprint: fingerprintOf(pem) }))

  it('reports first use as neither a match nor a mismatch', async () => {
    const result = await consoleCertRequest({ host: '10.0.0.1' }, { readCert: readCert(CERT_A) })

    expect(result.matches).toBeNull()
    expect(result.trustedFingerprint).toBeNull()
    expect(result.fingerprint).toBe(fingerprintOf(CERT_A))
    expect(result.pem).toBe(CERT_A)
  })

  it('confirms a certificate that still matches', async () => {
    const result = await consoleCertRequest({ host: '10.0.0.1', consoleCert: CERT_A }, { readCert: readCert(CERT_A) })

    expect(result.matches).toBe(true)
  })

  // The UI stops here and never sends the key — see index.html.
  it('reports a changed certificate as a mismatch, with both fingerprints', async () => {
    const result = await consoleCertRequest({ host: '10.0.0.1', consoleCert: CERT_A }, { readCert: readCert(CERT_B) })

    expect(result.matches).toBe(false)
    expect(result.trustedFingerprint).toBe(fingerprintOf(CERT_A))
    expect(result.fingerprint).toBe(fingerprintOf(CERT_B))
  })

  it('rejects an empty host without touching the network', async () => {
    const read = readCert(CERT_A)
    await expect(consoleCertRequest({ host: '' }, { readCert: read })).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
  })
})

describe('discoverRequest', () => {
  it('returns capability flags so the UI cannot offer impossible settings', async () => {
    const cameras = [{
      id: 'cam1',
      name: 'Doorbell',
      modelKey: 'camera',
      hasPackageCamera: true,
      featureFlags: { hasSpeaker: true, hasMic: true, hasLedStatus: true, smartDetectTypes: ['person', 'package'] },
    }]
    const fetchImpl = vi.fn(async (url: string) => ok(url.endsWith('/cameras') ? cameras : [])) as never

    const result = await discoverRequest(creds, { fetchImpl })

    expect(result.devices[0]).toEqual({
      id: 'cam1',
      name: 'Doorbell',
      type: 'camera',
      hasSpeaker: true,
      // Without this the audio toggle is never offered and nothing else notices.
      hasMic: true,
      hasLedStatus: true,
      hasPackageCamera: true,
      smartDetectTypes: ['person', 'package'],
    })
  })

  it('reports a missing microphone as false rather than undefined', async () => {
    const cameras = [{ id: 'cam1', name: 'Sidegate', modelKey: 'camera', featureFlags: {} }]
    const fetchImpl = vi.fn(async (url: string) => ok(url.endsWith('/cameras') ? cameras : [])) as never

    const result = await discoverRequest(creds, { fetchImpl })

    expect(result.devices[0]?.hasMic).toBe(false)
  })
})
