import type { Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { httpsRequestFn } from '../src/protect/http.js'

// A real TLS socket is the only thing that proves `rejectUnauthorized: false`
// works, and TLS needs a certificate. The key/cert are generated per run into a
// temp dir rather than checked in, so no private key ever lands in the repo.
let tls: { key: string, cert: string }

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'protect-http-test-'))
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-keyout',
    join(dir, 'key.pem'),
    '-out',
    join(dir, 'cert.pem'),
    '-days',
    '1',
    '-nodes',
    '-subj',
    '/CN=localhost',
  ], { stdio: 'ignore' })
  tls = { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') }
  rmSync(dir, { recursive: true, force: true })
})

let server: Server | undefined

/** Stands up a throwaway TLS server and returns its base URL. */
async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(tls, handler)
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return `https://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

afterEach(async () => {
  if (!server)
    return
  const closing = server
  server = undefined
  await new Promise<void>(resolve => closing.close(() => resolve()))
})

describe('httpsRequestFn', () => {
  it('resolves status, headers and body for a 200, ignoring the self-signed certificate', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-thing': 'yes' })
      res.end(JSON.stringify({ hello: 'world' }))
    })

    const response = await httpsRequestFn(`${base}/thing`)

    expect(response.status).toBe(200)
    expect(response.headers['x-thing']).toBe('yes')
    expect(JSON.parse(response.body.toString())).toEqual({ hello: 'world' })
  })

  it('sends the method, headers and body through', async () => {
    let seen: { method?: string, key?: string | string[], body?: string } = {}
    const base = await serve((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        seen = { method: req.method, key: req.headers['x-api-key'], body: Buffer.concat(chunks).toString() }
        res.writeHead(204)
        res.end()
      })
    })

    await httpsRequestFn(`${base}/thing`, {
      method: 'POST',
      headers: { 'X-API-KEY': 'secret' },
      body: '{"a":1}',
    })

    expect(seen).toEqual({ method: 'POST', key: 'secret', body: '{"a":1}' })
  })

  it('resolves rather than rejecting for a non-2xx — status mapping is the client\'s job', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(429, { 'retry-after': '7' })
      res.end('slow down')
    })

    const response = await httpsRequestFn(`${base}/thing`)

    expect(response.status).toBe(429)
    expect(response.headers['retry-after']).toBe('7')
    expect(response.body.toString()).toBe('slow down')
  })

  it('rejects when the socket dies mid-flight', async () => {
    const base = await serve((req) => {
      req.socket.destroy()
    })

    await expect(httpsRequestFn(`${base}/thing`)).rejects.toThrow()
  })

  it('rejects via timeout rather than hanging when the server never responds', async () => {
    // Handler deliberately never calls res.end().
    const base = await serve(() => {})

    await expect(httpsRequestFn(`${base}/thing`, { timeoutMs: 50 })).rejects.toThrow('Request timed out')
  })
})
