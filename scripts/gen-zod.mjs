#!/usr/bin/env node
// Generates src/protect/schemas.ts from the vendored OpenAPI 3.1 document.
// OpenAPI 3.1 schemas ARE JSON Schema, so this mapping is mechanical.
import { readFileSync, writeFileSync } from 'node:fs'

const SPEC = 'spec/protect-7.1.87.openapi.json'
const OUT = 'src/protect/schemas.ts'

const spec = JSON.parse(readFileSync(SPEC, 'utf8'))
const schemas = spec.components.schemas

/** OpenAPI schema name -> exported TS identifier. `camera` -> `cameraSchema`. */
const idOf = name => `${name.replace(/[^a-z0-9]/gi, '_')}Schema`

const lit = v => JSON.stringify(v)

/**
 * Properties the spec marks `required` that real Protect 7.1.87 hardware omits.
 * Verified against a live UDM-Pro:
 *  - ringSettings.ringtoneId is absent when the paired camera uses the default
 *    ringtone;
 *  - nvrArmMode.armProfileId is absent while the alarm is `disabled`.
 * Honouring the spec here would reject genuine payloads, so these are emitted
 * optional. Keyed by schema title (falling back to the component name).
 */
const OPTIONAL_OVERRIDES = {
  ringSettings: ['ringtoneId'],
  nvrArmMode: ['armProfileId'],
}

function convert(node, name) {
  if (!node || typeof node !== 'object')
    return 'z.unknown()'

  if (node.$ref) {
    const target = node.$ref.replace('#/components/schemas/', '')
    if (target === name)
      return 'z.lazy(() => z.unknown())' // no self-refs in this spec; guard anyway
    return idOf(target)
  }

  if (node.const !== undefined)
    return `z.literal(${lit(node.const)})`

  if (node.enum) {
    if (node.enum.length === 1)
      return `z.literal(${lit(node.enum[0])})`
    // z.enum only accepts string members; anything else becomes a literal union.
    return node.enum.every(v => typeof v === 'string')
      ? `z.enum([${node.enum.map(lit).join(', ')}])`
      : `z.union([${node.enum.map(v => `z.literal(${lit(v)})`).join(', ')}])`
  }

  // allOf with a single member is the spec's way of attaching constraints to a $ref.
  if (node.allOf) {
    const parts = node.allOf.map(n => convert(n, name))
    return parts.length === 1 ? parts[0] : parts.slice(1).reduce((a, b) => `z.intersection(${a}, ${b})`, parts[0])
  }

  if (node.oneOf || node.anyOf) {
    const members = node.oneOf ?? node.anyOf
    const key = node.discriminator?.propertyName
    const inner = members.map(n => convert(n, name))
    if (key && node.oneOf)
      return `z.discriminatedUnion(${lit(key)}, [${inner.join(', ')}])`
    return `z.union([${inner.join(', ')}])`
  }

  // `type` may be an array such as ["string", "null"] — 95 occurrences in this spec.
  if (Array.isArray(node.type)) {
    const nonNull = node.type.filter(t => t !== 'null')
    const bases = nonNull.map(t => convert({ ...node, type: t }, name))
    const base = bases.length === 1 ? bases[0] : `z.union([${bases.join(', ')}])`
    return node.type.includes('null') ? `${base}.nullable()` : base
  }

  switch (node.type) {
    case 'string':
      return node.format === 'uri' ? 'z.url()' : withStr(node, 'z.string()')
    case 'number':
      return withNum(node, 'z.number()')
    case 'integer':
      return withNum(node, 'z.number().int()')
    case 'boolean':
      return 'z.boolean()'
    case 'null':
      return 'z.null()'
    case 'array':
      return `z.array(${convert(node.items, name)})`
    case 'object':
      return objectOf(node, name)
    default:
      return node.properties ? objectOf(node, name) : 'z.unknown()'
  }
}

function withStr(node, base) {
  let s = base
  if (node.minLength !== undefined)
    s += `.min(${node.minLength})`
  if (node.maxLength !== undefined)
    s += `.max(${node.maxLength})`
  return s
}

function withNum(node, base) {
  let s = base
  if (node.minimum !== undefined)
    s += `.min(${node.minimum})`
  if (node.maximum !== undefined)
    s += `.max(${node.maximum})`
  return s
}

function objectOf(node, name) {
  const props = node.properties ?? {}
  const required = new Set(node.required ?? [])
  for (const key of OPTIONAL_OVERRIDES[node.title ?? name] ?? []) required.delete(key)
  const entries = Object.entries(props).map(([key, value]) => {
    const optional = required.has(key) ? '' : '.optional()'
    return `  ${JSON.stringify(key)}: ${convert(value, name)}${optional},`
  })
  // Unknown keys are PRESERVED, not stripped. A firmware update that adds a
  // field must not silently drop it, and must never fail validation.
  const fn = node.additionalProperties === false ? 'z.strictObject' : 'z.looseObject'
  const body = entries.length ? `${fn}({\n${entries.join('\n')}\n})` : `${fn}({})`
  // A schema whose additionalProperties is itself a schema constrains the values.
  if (node.additionalProperties && typeof node.additionalProperties === 'object')
    return `z.record(z.string(), ${convert(node.additionalProperties, name)})`
  return body
}

/**
 * Emit in dependency order so no schema references an identifier declared later.
 * Kahn-style topological sort over $ref edges; ties broken alphabetically so
 * output is byte-stable across runs.
 */
function order(names) {
  const deps = new Map(names.map(n => [n, refsOf(schemas[n])]))
  const done = new Set()
  const out = []
  while (out.length < names.length) {
    const ready = names
      .filter(n => !done.has(n) && [...deps.get(n)].every(d => done.has(d) || !deps.has(d)))
      .sort()
    if (!ready.length) {
      // Cycle: emit the rest alphabetically. This spec has none, but never hang.
      out.push(...names.filter(n => !done.has(n)).sort())
      break
    }
    for (const n of ready) {
      out.push(n)
      done.add(n)
    }
  }
  return out
}

function refsOf(node, acc = new Set()) {
  if (!node || typeof node !== 'object')
    return acc
  if (Array.isArray(node)) {
    node.forEach(n => refsOf(n, acc))
    return acc
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref' && typeof v === 'string')
      acc.add(v.replace('#/components/schemas/', ''))
    else refsOf(v, acc)
  }
  return acc
}

const names = order(Object.keys(schemas))
const body = names.map((n) => {
  const id = idOf(n)
  const type = id.replace(/Schema$/, '')
  const typeName = type.charAt(0).toUpperCase() + type.slice(1)
  return `export const ${id} = ${convert(schemas[n], n)}\nexport type ${typeName} = z.infer<typeof ${id}>\n`
}).join('\n')

writeFileSync(OUT, `// GENERATED by scripts/gen-zod.mjs from ${SPEC}. Do not edit by hand.
// Regenerate with: npm run gen:zod
/* eslint-disable */
import { z } from 'zod'

${body}`)

console.log(`wrote ${OUT} (${names.length} schemas)`)
