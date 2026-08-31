#!/usr/bin/env node
// Redacts test/fixtures/*.json in place: real device ids, MAC addresses and
// RTSPS stream tokens are replaced with fakes of the same length and shape.
//
// The mapping is a hash, not a counter, so it is stable across runs and files:
// the same real id always yields the same fake id. Cross-references such as
// chimes[].cameraIds -> cameras[].id therefore keep matching after redaction,
// which the reconciliation tests depend on.
//
// Run this exactly once, immediately after capturing. It is not idempotent:
// a second run would re-hash the already-fake ids (harmlessly, but it would
// break cross-references against fixtures captured earlier).
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

const DIR = 'test/fixtures'
const hash = (s, n) => createHash('sha256').update(`protect-fixture:${s}`).digest('hex').slice(0, n)

function redact(text) {
  return text
  // 24-hex-character device ids
    .replace(/\b[0-9a-f]{24}\b/g, m => hash(m, 24))
  // device GUIDs, e.g. d3784320-1c25-43d1-b7a0-5b640bf2adff
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (m) => {
      const h = hash(m, 32)
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
    })
  // bare MAC addresses as Protect reports them, e.g. AABBCCDDEE01
    .replace(/\b[0-9A-F]{12}\b/g, m => hash(m, 12).toUpperCase())
  // rtsps://host:7441/<token>
    .replace(/(rtsps:\/\/[^/]+\/)[A-Za-z0-9]+/g, (_, p) => `${p}${'x'.repeat(16)}`)
}

for (const file of readdirSync(DIR).filter(f => f.endsWith('.json'))) {
  const path = `${DIR}/${file}`
  const before = readFileSync(path, 'utf8')
  const after = redact(before)
  if (after !== before) {
    writeFileSync(path, after)
    console.log(`redacted ${path}`)
  }
}
