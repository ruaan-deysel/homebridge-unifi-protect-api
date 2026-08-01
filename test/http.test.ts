import type { Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { TestCert } from './support/tls.js'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:https'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { httpsRequestFn } from '../src/protect/http.js'
import { makeSelfSigned } from './support/tls.js'

const API_KEY = 'SUPER-SECRET-KEY'

/** The console's own certificate, and an impostor's — a MITM on the LAN. */
let real: TestCert
let impostor: TestCert

beforeAll(() => {
  real = makeSelfSigned('unifi.local')
  impostor = makeSelfSigned('unifi.local')
})

let server: Server | undefined

interface Peer {
  base: string
  /**
   * What the peer decrypted. This is the right — and only meaningful — place to
   * observe a leak: a peer presenting its own certificate holds its own private
   * key, so anything the client writes after the handshake is readable to it.
   * "No request arrived here" therefore means the credential never left this
   * machine, not merely that it was encrypted on the way out.
   */
  requests: { key?: string | string[] }[]
  /** TCP connections accepted, whether or not a handshake completed. */
  connections: number
}

/** Stands up a throwaway TLS server presenting `tls` and returns what it sees. */
async function serve(tls: TestCert, handler: Parameters<typeof createServer>[1] = (_req, res) => res.end('{}')): Promise<Peer> {
  const peer = { requests: [] as Peer['requests'], connections: 0 } as Peer
  server = createServer(tls, (req, res) => {
    peer.requests.push({ key: req.headers['x-api-key'] })
    handler?.(req, res)
  })
  server.on('connection', () => peer.connections++)
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  peer.base = `https://127.0.0.1:${(server!.address() as AddressInfo).port}`
  return peer
}

afterEach(async () => {
  if (!server)
    return
  const closing = server
  server = undefined
  await new Promise<void>(resolve => closing.close(() => resolve()))
})

describe('httpsRequestFn', () => {
  it('resolves status, headers and body for a 200 over the pinned certificate', async () => {
    const peer = await serve(real, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-thing': 'yes' })
      res.end(JSON.stringify({ hello: 'world' }))
    })

    const response = await httpsRequestFn(`${peer.base}/thing`, { consoleCert: real.cert })

    expect(response.status).toBe(200)
    expect(response.headers['x-thing']).toBe('yes')
    expect(JSON.parse(response.body.toString())).toEqual({ hello: 'world' })
  })

  // The positive control for the pinning test below: with the right
  // certificate the key DOES arrive, so "the key never arrived" is a real
  // observation rather than a test that could never see it either way.
  it('sends the method, headers and body through', async () => {
    let seen: { method?: string, key?: string | string[], body?: string } = {}
    const peer = await serve(real, (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        seen = { method: req.method, key: req.headers['x-api-key'], body: Buffer.concat(chunks).toString() }
        res.writeHead(204)
        res.end()
      })
    })

    await httpsRequestFn(`${peer.base}/thing`, {
      method: 'POST',
      headers: { 'X-API-KEY': API_KEY },
      body: '{"a":1}',
      consoleCert: real.cert,
    })

    expect(seen).toEqual({ method: 'POST', key: API_KEY, body: '{"a":1}' })
  })

  // THE test. A connection that merely "fails" proves nothing — it could fail
  // for any reason. What matters is that the credential never left the machine.
  it('does not deliver the api key to a peer presenting a different certificate', async () => {
    const peer = await serve(impostor)

    await expect(httpsRequestFn(`${peer.base}/thing`, {
      headers: { 'X-API-KEY': API_KEY },
      consoleCert: real.cert,
    })).rejects.toThrow()

    // The impostor was dialled — this is not a test that failed to connect for
    // some unrelated reason ...
    expect(peer.connections).toBe(1)
    // ... and it decrypted nothing: no request, so no `X-API-KEY`, ever
    // reached it. The pin rejected the certificate mid-handshake, before node
    // wrote the headers.
    expect(peer.requests).toEqual([])
  })

  // Same proof for the `ws` transport's sibling failure mode: a certificate
  // that is valid but simply not the pinned one must not be accepted just
  // because it chains to a public CA or shares a subject.
  it('rejects a peer whose certificate shares the subject but not the key', async () => {
    const peer = await serve(impostor)

    await expect(httpsRequestFn(`${peer.base}/thing`, { consoleCert: real.cert })).rejects.toThrow()
    expect(peer.requests).toEqual([])
  })

  it('refuses to send anything at all when no certificate has been trusted', async () => {
    const peer = await serve(real)

    await expect(httpsRequestFn(`${peer.base}/thing`, { headers: { 'X-API-KEY': API_KEY } }))
      .rejects
      .toThrow(/certificate has(?: not)? been trusted/)

    expect(peer.requests).toEqual([])
    // Not even a TCP connection: nothing was dialled at all.
    expect(peer.connections).toBe(0)
  })

  it('resolves rather than rejecting for a non-2xx — status mapping is the client\'s job', async () => {
    const peer = await serve(real, (_req, res) => {
      res.writeHead(429, { 'retry-after': '7' })
      res.end('slow down')
    })

    const response = await httpsRequestFn(`${peer.base}/thing`, { consoleCert: real.cert })

    expect(response.status).toBe(429)
    expect(response.headers['retry-after']).toBe('7')
    expect(response.body.toString()).toBe('slow down')
  })

  it('rejects when the socket dies mid-flight', async () => {
    const peer = await serve(real, req => req.socket.destroy())

    await expect(httpsRequestFn(`${peer.base}/thing`, { consoleCert: real.cert })).rejects.toThrow()
  })

  it('rejects via timeout rather than hanging when the server never responds', async () => {
    // Handler deliberately never calls res.end().
    const peer = await serve(real, () => {})

    await expect(httpsRequestFn(`${peer.base}/thing`, { timeoutMs: 50, consoleCert: real.cert }))
      .rejects
      .toThrow('Request timed out')
  })
})
