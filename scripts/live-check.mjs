#!/usr/bin/env node
// Manual smoke test. NOT part of `npm test`. Run this after a Protect firmware
// update to find out what changed before your users do.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import https from 'node:https'
import { isIP } from 'node:net'
import process from 'node:process'
import { connect } from 'node:tls'
import WebSocket from 'ws'

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .map(line => line.match(/^([A-Z_]+)=(.*)$/))
    .filter(Boolean)
    .map(m => [m[1], m[2].trim()]),
)

const host = env.PROTECT_HOST ?? process.env.PROTECT_HOST
const apiKey = env.PROTECT_API_KEY ?? process.env.PROTECT_API_KEY
if (!host || !apiKey) {
  console.error('Set PROTECT_HOST and PROTECT_API_KEY in .env')
  process.exit(2)
}

const base = `https://${host}/proxy/protect/integration/v1`
let failed = 0

/**
 * Reads the console's certificate over a handshake that sends nothing, then
 * pins every request in this run to it — this script carries the same API key
 * the plugin does, so it must not be the one place that would hand it to
 * anything that answers on the LAN. Same shape as src/protect/cert.ts;
 * `checkServerIdentity` skips the hostname check ONLY (the cert is issued for
 * the UDM's hostname while we connect by IP), certificate identity is enforced.
 *
 * Trust on first use, per run: the fingerprint is printed so you can compare it
 * with the one your console shows.
 */
const pinned = await new Promise((resolve, reject) => {
  const url = new URL(`https://${host}`)
  const socket = connect({
    host: url.hostname,
    port: Number(url.port || 443),
    // SNI for a DNS name so a console fronting several certs presents the right
    // one; omitted for an IP literal, where SNI is invalid.
    servername: isIP(url.hostname) ? undefined : url.hostname,
    rejectUnauthorized: false,
  }, () => {
    const raw = socket.getPeerCertificate().raw
    socket.destroy()
    const pem = `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE-----\n`
    const fingerprint = createHash('sha256').update(raw).digest('hex').toUpperCase().replace(/..(?!$)/g, '$&:')
    // Never hand the API key to a peer trusted only on first sight. Require a
    // fingerprint supplied out of band (PROTECT_CERT_SHA256); with none set,
    // print what the console presents and stop so it can be verified and set.
    const configuredFingerprint = env.PROTECT_CERT_SHA256?.trim() || process.env.PROTECT_CERT_SHA256?.trim() || ''
    const expected = configuredFingerprint.replace(/[^0-9a-f]/gi, '').toUpperCase()
    if (!expected) {
      reject(new Error(`No PROTECT_CERT_SHA256 set. ${host} presents SHA-256 ${fingerprint} — verify it against the UniFi console, set PROTECT_CERT_SHA256 to it in .env, and rerun.`))
      return
    }
    if (expected.length !== 64) {
      reject(new Error('PROTECT_CERT_SHA256 must contain a SHA-256 fingerprint'))
      return
    }
    if (expected !== fingerprint.replace(/:/g, '')) {
      reject(new Error(`${host} presented SHA-256 ${fingerprint}, which does not match PROTECT_CERT_SHA256 — refusing to send the API key`))
      return
    }
    console.log(`      Pinned to ${host} — SHA-256 ${fingerprint} (matches PROTECT_CERT_SHA256)\n`)
    // checkServerIdentity replaces the hostname check ONLY and is not a no-op:
    // it pins every later request in this run to the exact certificate read here.
    resolve({
      rejectUnauthorized: true,
      ca: [pem],
      checkServerIdentity: (_host, cert) => cert.raw.equals(raw)
        ? undefined
        : new Error('the console certificate changed mid-run'),
    })
  })
  socket.setTimeout(15_000, () => socket.destroy(new Error('timed out reading the certificate')))
  socket.on('error', reject)
})

// node:https, not fetch. fetch cannot be given a custom trust anchor without an
// undici dispatcher, and silently ignores an `agent` option.
function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers: { 'X-API-KEY': apiKey }, ...pinned }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] ?? '', body: Buffer.concat(chunks) }))
    })
    req.setTimeout(15_000, () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    req.end()
  })
}

async function check(label, path, validate) {
  try {
    const response = await get(`${base}${path}`)
    if (response.status < 200 || response.status >= 300)
      throw new Error(`HTTP ${response.status}`)
    const body = response.type.includes('json') ? JSON.parse(response.body.toString()) : response.body
    validate?.(body)
    console.log(`PASS  ${label}`)
    return body
  }
  catch (error) {
    failed++
    console.error(`FAIL  ${label} — ${error.message}`)
    return null
  }
}

function assert(condition, message) {
  if (!condition)
    throw new Error(message)
}

const info = await check('meta/info', '/meta/info', b => assert(b.applicationVersion, 'no applicationVersion'))
if (info)
  console.log(`      Protect ${info.applicationVersion}`)

const cameras = await check('cameras', '/cameras', b => assert(Array.isArray(b), 'not an array'))
await check('nvrs', '/nvrs', b => assert(b.id, 'no nvr id'))
await check('chimes', '/chimes', b => assert(Array.isArray(b), 'not an array'))
await check('lights', '/lights', b => assert(Array.isArray(b), 'not an array'))
await check('sensors', '/sensors', b => assert(Array.isArray(b), 'not an array'))
await check('liveviews', '/liveviews', b => assert(Array.isArray(b), 'not an array'))

const id = cameras?.[0]?.id
if (id) {
  await check('snapshot', `/cameras/${id}/snapshot?highQuality=true`, b => assert(b.length > 1000, 'snapshot too small'))
  await check('rtsps-stream', `/cameras/${id}/rtsps-stream?qualities=high`, b => assert(b.high?.startsWith('rtsps://'), 'no high stream'))
}

for (const channel of ['devices', 'events']) {
  await new Promise((resolve) => {
    const socket = new WebSocket(`wss://${host}/proxy/protect/integration/v1/subscribe/${channel}`, {
      headers: { 'X-API-KEY': apiKey },
      ...pinned,
    })
    const timer = setTimeout(() => {
      failed++
      console.error(`FAIL  ws/${channel} — no open within 10s`)
      socket.close()
      resolve()
    }, 10_000)
    socket.onopen = () => {
      clearTimeout(timer)
      console.log(`PASS  ws/${channel}`)
      socket.close()
      resolve()
    }
    socket.onerror = () => {
      clearTimeout(timer)
      failed++
      console.error(`FAIL  ws/${channel} — connection error`)
      resolve()
    }
  })
}

console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.')
process.exit(failed ? 1 : 0)
