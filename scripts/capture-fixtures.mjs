#!/usr/bin/env node
// One-shot: re-captures the device fixtures from the live console so the
// fixtures match the hardware the plugin is tested against (Protect 7.2.105).
// Run scripts/redact-fixtures.mjs immediately afterwards, exactly once.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { isIP } from 'node:net'
import process from 'node:process'
import { connect } from 'node:tls'

const env = Object.fromEntries(
  readFileSync('.env', 'utf8').split('\n').map(l => l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]),
)
const host = env.PROTECT_HOST
const apiKey = env.PROTECT_API_KEY
const expected = (env.PROTECT_CERT_SHA256 ?? '').replace(/[^0-9a-f]/gi, '').toUpperCase()
if (!host || !apiKey) {
  console.error('Set PROTECT_HOST and PROTECT_API_KEY in .env')
  process.exit(2)
}
if (expected.length !== 64) {
  console.error('Set PROTECT_CERT_SHA256 in .env (SHA-256 of the console certificate)')
  process.exit(2)
}

const pinned = await new Promise((resolve, reject) => {
  const url = new URL(`https://${host}`)
  const socket = connect({
    host: url.hostname,
    port: Number(url.port || 443),
    servername: isIP(url.hostname) ? undefined : url.hostname,
    rejectUnauthorized: false,
  }, () => {
    const raw = socket.getPeerCertificate().raw
    socket.destroy()
    const fingerprint = createHash('sha256').update(raw).digest('hex').toUpperCase().replace(/..(?!$)/g, '$&:')
    if (expected !== fingerprint.replaceAll(':', '')) {
      reject(new Error(`Console presented ${fingerprint}, which does not match PROTECT_CERT_SHA256 — refusing to send the API key`))
      return
    }
    console.log(`Pinned to ${host} — SHA-256 ${fingerprint}`)
    const pem = `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE-----\n`
    resolve({ rejectUnauthorized: true, ca: [pem], checkServerIdentity: (_h, c) => c.raw.equals(raw) ? undefined : new Error('cert changed') })
  })
  socket.setTimeout(15_000, () => socket.destroy(new Error('timed out reading the certificate')))
  socket.on('error', reject)
})

function get(path) {
  return new Promise((resolve, reject) => {
    const r = https.request(`https://${host}/proxy/protect/integration/v1${path}`, { headers: { 'X-API-KEY': apiKey }, ...pinned }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }))
    })
    r.setTimeout(15_000, () => r.destroy(new Error('timed out')))
    r.on('error', reject)
    r.end()
  })
}

async function capture(path, file, transform) {
  const r = await get(path)
  if (r.status !== 200) {
    console.error(`FAIL ${path}: HTTP ${r.status}`)
    process.exit(1)
  }
  let body = JSON.parse(r.body)
  if (transform)
    body = transform(body)
  writeFileSync(`test/fixtures/${file}`, `${JSON.stringify(body, null, 2)}\n`)
  console.log(`captured ${file} (${path})`)
}

const cameras = JSON.parse((await get('/cameras')).body)
await capture('/cameras', 'cameras.json')
await capture('/chimes', 'chimes.json')
const lights = JSON.parse((await get('/lights')).body)
if (lights.length > 0)
  await capture('/lights', 'lights.json')
else
  console.log('skipped lights.json — the console reports no lights, keeping the existing fixture')
await capture('/liveviews', 'liveviews.json')
await capture('/sensors', 'sensors.json')
await capture('/nvrs', 'nvrs.json')
await capture('/meta/info', 'meta-info.json', info => ({ applicationVersion: info.applicationVersion }))
const doorbell = cameras.find(c => c.name === 'Doorbell') ?? cameras[0]
await capture(`/cameras/${doorbell.id}/rtsps-stream?qualities=high,medium,low`, 'rtsps-stream.json')
console.log('done')
