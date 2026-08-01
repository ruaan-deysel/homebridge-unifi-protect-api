#!/usr/bin/env node
// Captures live Protect event frames to build test fixtures from observed data
// rather than from the OpenAPI spec. The spec has already been wrong twice on
// this hardware (ringSettings.ringtoneId, nvrArmMode.armProfileId are marked
// required but never sent), so event shapes are not trusted until seen.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import WebSocket from 'ws'

const env = Object.fromEntries(
  readFileSync('.env', 'utf8').split('\n')
    .map(l => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean)
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

for (const channel of ['devices', 'events']) {
  const ws = new WebSocket(`wss://${host}/proxy/protect/integration/v1/subscribe/${channel}`, {
    headers: { 'X-API-KEY': apiKey },
    rejectUnauthorized: false,
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
