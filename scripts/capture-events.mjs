#!/usr/bin/env node
// Captures live Protect event frames to build test fixtures from observed data
// rather than from the OpenAPI spec. The spec has already been wrong twice on
// this hardware (ringSettings.ringtoneId, nvrArmMode.armProfileId are marked
// required but never sent), so event shapes are not trusted until seen.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import process from 'node:process'
import { connect } from 'node:tls'
import WebSocket from 'ws'

const env = Object.fromEntries(
  readFileSync('.env', 'utf8').split('\n')
    .map(l => l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)).filter(Boolean)
    .map(m => [m[1], m[2].trim()]),
)
const host = env.PROTECT_HOST
const apiKey = env.PROTECT_API_KEY
if (!host || !apiKey) {
  console.error('Set PROTECT_HOST and PROTECT_API_KEY in .env')
  process.exit(2)
}

const seconds = Number(process.argv[process.argv.indexOf('--seconds') + 1]) || 120
const frames = []

// Read the console's certificate over a handshake that sends nothing, then pin
// every subscription to it — these sockets carry the API key, so validation is
// never disabled on them. checkServerIdentity replaces the hostname check ONLY.
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
      reject(new Error(`${host} presented SHA-256 ${fingerprint}, which does not match PROTECT_CERT_SHA256`))
      return
    }
    console.error(`      Pinned to ${host} — SHA-256 ${fingerprint} (matches PROTECT_CERT_SHA256)`)
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

for (const channel of ['devices', 'events']) {
  const ws = new WebSocket(`wss://${host}/proxy/protect/integration/v1/subscribe/${channel}`, {
    headers: { 'X-API-KEY': apiKey },
    ...pinned,
  })
  ws.on('open', () => console.error(`[${channel}] listening`))
  ws.on('error', e => console.error(`[${channel}] error: ${e.message}`))
  ws.on('message', (raw) => {
    let payload
    try {
      payload = JSON.parse(raw.toString())
    }
    catch {
      return
    }
    frames.push({ channel, at: Date.now(), payload })
    const item = payload.item ?? {}
    console.error(`[${channel}] ${payload.type} ${item.type ?? item.modelKey ?? ''} ${item.smartDetectTypes ? JSON.stringify(item.smartDetectTypes) : ''}`)
  })
}

console.error(`\nWalk past a camera, then press the doorbell. Capturing for ${seconds}s...\n`)
setTimeout(() => {
  mkdirSync('test/fixtures/events', { recursive: true })
  writeFileSync('test/fixtures/events/raw-capture.json', JSON.stringify(frames, null, 2))
  console.error(`\nWrote ${frames.length} frames to test/fixtures/events/raw-capture.json`)
  process.exit(0)
}, seconds * 1000)
