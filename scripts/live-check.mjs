#!/usr/bin/env node
// Manual smoke test. NOT part of `npm test`. Run this after a Protect firmware
// update to find out what changed before your users do.
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import https from 'node:https'
import process from 'node:process'
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

// node:https, not fetch. fetch cannot skip verification of the console's
// self-signed certificate, and silently ignores an `agent` option.
function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers: { 'X-API-KEY': apiKey }, rejectUnauthorized: false }, (res) => {
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
      rejectUnauthorized: false,
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
