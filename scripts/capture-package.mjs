#!/usr/bin/env node
// Captures the console's real package-channel responses. Detection has no
// feature flag — `hasPackageCamera` does not exist in featureFlags — so the
// probe asks for the channel and reads the answer. That answer's shape is what
// the probe parses, and it must come from the console, not from imagination.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { connect } from 'node:tls'

const env = Object.fromEntries(
  readFileSync('.env', 'utf8').split('\n')
    .map(l => l.match(/^(PROTECT_[A-Z_]+)=(.*)$/)).filter(Boolean)
    .map(m => [m[1], m[2].trim()]),
)

/** Replaces every real URL with a structurally identical fake. */
function redact(payload) {
  const out = {}
  for (const [k, v] of Object.entries(payload))
    out[k] = typeof v === 'string' && v.startsWith('rtsps://') ? 'rtsps://fake.invalid:7441/fakestream?token=FAKE-TOKEN' : v
  return out
}

/**
 * Reads the console's certificate over a handshake that sends nothing, then
 * pins every request to it. This script carries the same API key the plugin
 * does, so it must not be the one place that hands it to anything answering on
 * the LAN. Inlined rather than imported from `src/protect/cert.ts`, because a
 * plain .mjs script cannot import TypeScript source — `scripts/live-check.mjs`
 * does exactly the same for exactly that reason. `checkServerIdentity` skips
 * the HOSTNAME check only (the cert is issued for the UDM's hostname while we
 * connect by IP); certificate identity is still enforced.
 */
const pinned = await new Promise((resolve, reject) => {
  const url = new URL(`https://${env.PROTECT_HOST}`)
  const socket = connect({ host: url.hostname, port: Number(url.port || 443), rejectUnauthorized: false }, () => {
    const raw = socket.getPeerCertificate().raw
    socket.destroy()
    const pem = `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE-----\n`
    const fingerprint = createHash('sha256').update(raw).digest('hex').toUpperCase().replace(/..(?!$)/g, '$&:')
    console.error(`pinned to ${env.PROTECT_HOST} — SHA-256 ${fingerprint}`)
    resolve({ rejectUnauthorized: true, ca: [pem], checkServerIdentity: () => undefined })
  })
  socket.setTimeout(15_000, () => socket.destroy(new Error('timed out reading the certificate')))
  socket.on('error', reject)
})

function api(method, path, body) {
  const data = body ? JSON.stringify(body) : undefined
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: env.PROTECT_HOST,
      path: `/proxy/protect/integration/v1${path}`,
      method,
      headers: { 'X-API-KEY': env.PROTECT_API_KEY, ...(data ? { 'Content-Type': 'application/json' } : {}) },
      ...pinned,
    }, (res) => {
      let b = ''
      res.on('data', d => b += d)
      res.on('end', () => resolve({ status: res.statusCode, body: b }))
    })
    req.on('error', reject)
    if (data)
      req.write(data)
    req.end()
  })
}

const cameras = JSON.parse((await api('GET', '/cameras')).body)
mkdirSync('test/fixtures/package', { recursive: true })

for (const camera of cameras) {
  const res = await api('POST', `/cameras/${camera.id}/rtsps-stream`, { qualities: ['package'] })
  const payload = JSON.parse(res.body || '{}')
  const redacted = redact(payload)
  // Refuse to write anything still carrying a live token.
  if (JSON.stringify(redacted).includes('token=') && !JSON.stringify(redacted).includes('FAKE-TOKEN'))
    throw new Error('redaction failed — refusing to write a fixture')
  const name = payload.package ? 'rtsps-package' : 'rtsps-none'
  writeFileSync(`test/fixtures/package/${name}.json`, JSON.stringify({ status: res.status, body: redacted }, null, 2))
  console.error(`${camera.name}: package=${payload.package ? 'yes' : 'no'} -> ${name}.json`)
}
