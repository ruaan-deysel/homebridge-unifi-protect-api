import type { ProtectLogger } from '../src/protect/client.js'
import type { HttpRequestFn, HttpResponse } from '../src/protect/http.js'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { inspect } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { ProtectClient } from '../src/protect/client.js'
import {
  ProtectAuthError,
  ProtectError,
  ProtectNotFoundError,
  ProtectRateLimitError,
  ProtectUnavailableError,
} from '../src/protect/errors.js'

const API_KEY = 'super-secret-api-key'

function fixture(name: string) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, body: Buffer.from(JSON.stringify(payload)) }
}

interface Harness {
  client: ProtectClient
  http: ReturnType<typeof vi.fn>
  log: ProtectLogger & { warn: ReturnType<typeof vi.fn> }
}

function harness(responder: HttpRequestFn): Harness {
  const http = vi.fn(responder)
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const client = new ProtectClient({
    host: '192.168.1.1',
    apiKey: API_KEY,
    log,
    httpRequest: http as unknown as HttpRequestFn,
    // No backoff sleeps in tests.
    queue: { maxRetries: 0 },
  })
  return { client, http, log }
}

describe('protectClient requests', () => {
  it('targets the integration API path with the X-API-KEY header', async () => {
    const { client, http } = harness(async () => jsonResponse(fixture('cameras')))

    await client.getCameras()

    expect(http).toHaveBeenCalledTimes(1)
    const [url, options] = http.mock.calls[0]!
    expect(url).toBe('https://192.168.1.1/proxy/protect/integration/v1/cameras')
    expect(options.headers['X-API-KEY']).toBe(API_KEY)
    expect(options.method).toBe('GET')
  })

  it('sends a JSON body with a content type on POST', async () => {
    const { client, http } = harness(async () => jsonResponse({ high: 'rtsps://host:7441/abc?enableSrtp' }))

    await client.createRtspsStream('cam1', ['high'])

    const [url, options] = http.mock.calls[0]!
    expect(url).toBe('https://192.168.1.1/proxy/protect/integration/v1/cameras/cam1/rtsps-stream')
    expect(options.method).toBe('POST')
    expect(options.headers['Content-Type']).toBe('application/json')
    // Without this node falls back to Transfer-Encoding: chunked.
    expect(options.headers['Content-Length']).toBe(String(Buffer.byteLength(options.body)))
    expect(JSON.parse(options.body)).toEqual({ qualities: ['high'] })
  })

  it('parses the fixtures for every list endpoint without warning', async () => {
    const { client, log } = harness(async (url) => {
      if (url.endsWith('/v1/cameras'))
        return jsonResponse(fixture('cameras'))
      if (url.endsWith('/v1/lights'))
        return jsonResponse(fixture('lights'))
      if (url.endsWith('/v1/sensors'))
        return jsonResponse(fixture('sensors'))
      if (url.endsWith('/v1/chimes'))
        return jsonResponse(fixture('chimes'))
      if (url.endsWith('/v1/viewers'))
        return jsonResponse(fixture('viewers'))
      if (url.endsWith('/v1/liveviews'))
        return jsonResponse(fixture('liveviews'))
      if (url.endsWith('/v1/nvrs'))
        return jsonResponse(fixture('nvrs'))
      return jsonResponse(fixture('meta-info'))
    })

    const [cameras, lights, sensors, chimes, viewers, liveviews] = await Promise.all([
      client.getCameras(),
      client.getLights(),
      client.getSensors(),
      client.getChimes(),
      client.getViewers(),
      client.getLiveviews(),
    ])
    const meta = await client.getMetaInfo()

    expect(cameras.length).toBeGreaterThan(0)
    expect(Array.isArray(lights)).toBe(true)
    expect(Array.isArray(sensors)).toBe(true)
    expect(Array.isArray(chimes)).toBe(true)
    expect(Array.isArray(viewers)).toBe(true)
    expect(Array.isArray(liveviews)).toBe(true)
    expect(meta.applicationVersion).toBe('7.1.87')
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('treats /v1/nvrs as a single object, not an array', async () => {
    const raw = fixture('nvrs')
    const { client, log } = harness(async () => jsonResponse(raw))

    const nvr = await client.getNvr()

    expect(Array.isArray(nvr)).toBe(false)
    expect(nvr.id).toBe(raw.id)
    expect(log.warn).not.toHaveBeenCalled()
  })
})

describe('protectClient error mapping', () => {
  it.each([
    [401, ProtectAuthError],
    [403, ProtectAuthError],
    [404, ProtectNotFoundError],
    [500, ProtectUnavailableError],
    [503, ProtectUnavailableError],
  ])('maps %i to the right typed error', async (status, expected) => {
    const { client } = harness(async () => ({ status, headers: {}, body: Buffer.alloc(0) }))

    await expect(client.getCamera('cam1')).rejects.toBeInstanceOf(expected)
  })

  it('maps an unexpected 4xx to the base ProtectError so it is not retried', async () => {
    const { client } = harness(async () => ({ status: 400, headers: {}, body: Buffer.alloc(0) }))

    const error = await client.getCamera('cam1').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProtectError)
    expect(error).not.toBeInstanceOf(ProtectUnavailableError)
  })

  it('parses Retry-After seconds into retryAfterMs', async () => {
    const { client } = harness(async () => ({ status: 429, headers: { 'retry-after': '7' }, body: Buffer.alloc(0) }))

    const error = await client.getCameras().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProtectRateLimitError)
    expect((error as ProtectRateLimitError).retryAfterMs).toBe(7000)
  })

  it.each([['Wed, 21 Oct 2026 07:28:00 GMT'], [''], ['0']])(
    'ignores a Retry-After of %o rather than producing NaN or a zero-delay retry storm',
    async (value) => {
      const { client } = harness(async () => ({
        status: 429,
        headers: { 'retry-after': value },
        body: Buffer.alloc(0),
      }))

      const error = await client.getCameras().catch((e: unknown) => e)
      expect((error as ProtectRateLimitError).retryAfterMs).toBeUndefined()
    },
  )

  it('caps an absurd Retry-After so a queue slot is not parked for an hour', async () => {
    const { client } = harness(async () => ({ status: 429, headers: { 'retry-after': '3600' }, body: Buffer.alloc(0) }))

    const error = await client.getCameras().catch((e: unknown) => e)
    expect((error as ProtectRateLimitError).retryAfterMs).toBe(60_000)
  })

  it('turns a transport rejection into ProtectUnavailableError', async () => {
    const { client } = harness(async () => {
      throw new Error('connect ECONNREFUSED')
    })

    await expect(client.getCameras()).rejects.toBeInstanceOf(ProtectUnavailableError)
  })

  it('never leaks the API key in a log line or an error message', async () => {
    const { client, log } = harness(async () => {
      // A hostile/naive transport error that embeds the key.
      throw new Error(`request failed with X-API-KEY: ${API_KEY}`)
    })

    // inspect(), not .message: `cause` is an own enumerable property, so
    // util.inspect renders it — and util.inspect is what log.error(err),
    // console.error(err) and node's unhandled-rejection printer all use.
    // Asserting on .message alone missed a real leak through the cause.
    const error = await client.getCameras().catch((e: unknown) => e)
    expect((error as Error).message).not.toContain(API_KEY)
    expect(inspect(error)).not.toContain(API_KEY)

    const { client: authClient, log: authLog } = harness(async () =>
      ({ status: 401, headers: {}, body: Buffer.from('nope') }))
    const authError = await authClient.getCameras().catch((e: unknown) => e)
    expect(inspect(authError)).not.toContain(API_KEY)

    // A console that echoes the key in a malformed error body must not leak either.
    const { client: junkClient } = harness(async () =>
      ({ status: 200, headers: {}, body: Buffer.from(`<html>${API_KEY}</html>`) }))
    const junkError = await junkClient.getCameras().catch((e: unknown) => e)
    expect(inspect(junkError)).not.toContain(API_KEY)

    for (const logger of [log, authLog]) {
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        for (const call of (logger[level] as ReturnType<typeof vi.fn>).mock.calls)
          expect(JSON.stringify(call)).not.toContain(API_KEY)
      }
    }
  })
})

describe('protectClient validation degrades instead of throwing', () => {
  it('returns the raw payload and warns exactly once across two calls', async () => {
    const broken = { ...fixture('cameras')[0], state: 'WOBBLY', id: 12345 }
    const { client, log } = harness(async () => jsonResponse(broken))

    const first = await client.getCamera('cam1')
    const second = await client.getCamera('cam1')

    expect(first).toEqual(broken)
    expect(second).toEqual(broken)
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('degrades when a firmware update adds a fifth quality tier to the strict RTSPS schema', async () => {
    // existingRtspsStreamsSchema is one of only two strictObject schemas in the
    // whole API, so an unknown key is a hard validation failure. Stream lookup
    // must survive it.
    const payload = { ...fixture('rtsps-stream'), ultra: 'rtsps://192.168.10.1:7441/zzz?enableSrtp' }
    const { client, log } = harness(async () => jsonResponse(payload))

    const streams = await client.getRtspsStream('cam1')

    expect(streams).toEqual(payload)
    expect(streams.high).toBe(payload.high)
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('keeps the good devices when one item in a list is malformed', async () => {
    const [good] = fixture('cameras')
    const { client, log } = harness(async () => jsonResponse([good, { id: 42 }]))

    const cameras = await client.getCameras()

    expect(cameras).toHaveLength(2)
    expect(cameras[0]).toEqual(good)
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('treats a non-list from a list endpoint as the console being unavailable', async () => {
    const { client } = harness(async () => jsonResponse({ error: 'nope' }))

    await expect(client.getCameras()).rejects.toBeInstanceOf(ProtectUnavailableError)
  })

  it('treats an empty body from a list endpoint as the console being unavailable', async () => {
    const { client } = harness(async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }))

    await expect(client.getCameras()).rejects.toBeInstanceOf(ProtectUnavailableError)
  })
})

describe('protectClient snapshots', () => {
  it('returns the raw Buffer without JSON parsing', async () => {
    const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46])
    const { client, http } = harness(async () => ({
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
      body: jpeg,
    }))

    const snapshot = await client.getSnapshot('cam1', { highQuality: true })

    expect(Buffer.isBuffer(snapshot)).toBe(true)
    expect(snapshot.equals(jpeg)).toBe(true)
    expect(http.mock.calls[0]![0]).toBe(
      'https://192.168.1.1/proxy/protect/integration/v1/cameras/cam1/snapshot?highQuality=true',
    )
  })

  it('omits the query string entirely when no options are given', async () => {
    const { client, http } = harness(async () => ({ status: 200, headers: {}, body: Buffer.from('x') }))

    await client.getSnapshot('cam1')

    expect(http.mock.calls[0]![0]).toBe(
      'https://192.168.1.1/proxy/protect/integration/v1/cameras/cam1/snapshot',
    )
  })
})
