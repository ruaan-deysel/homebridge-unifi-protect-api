#!/usr/bin/env node
// Generates src/protect/schemas.ts from the vendored OpenAPI 3.1 document.
// OpenAPI 3.1 schemas ARE JSON Schema, so this mapping is mechanical.
import { readFileSync, writeFileSync } from 'node:fs'

const SPEC = 'spec/protect-7.2.105.openapi.json'
const OUT = 'src/protect/schemas.ts'

const spec = JSON.parse(readFileSync(SPEC, 'utf8'))
const schemas = spec.components.schemas

/** OpenAPI schema name -> exported TS identifier. `camera` -> `cameraSchema`. */
const idOf = name => `${name.replace(/[^a-z0-9]/gi, '_')}Schema`

const lit = v => JSON.stringify(v)

/**
 * Properties the spec marks `required` that real Protect hardware omits.
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
  // Observed on live 7.2.105 hardware (2026-08-30, 5 cameras + chime): the spec
  // marks camera.lcdMessage required, but /cameras omits it unless a doorbell
  // message is currently set. Honouring the spec would reject genuine payloads.
  camera: ['lcdMessage'],
}

/**
 * Every JSON Schema keyword this generator understands, plus the annotation-only
 * ones it deliberately ignores. `convert` throws on anything else.
 *
 * This is the point of the whitelist: silently ignoring an unrecognised keyword
 * produces a quietly weaker schemas.ts with every test still green. A spec bump
 * that introduces `pattern`, `not` or `prefixItems` must break the build, loudly,
 * rather than emit validation that no longer says what the spec says.
 */
const HANDLED = new Set([
  '$ref',
  'type',
  'const',
  'enum',
  'allOf',
  'oneOf',
  'anyOf',
  'discriminator',
  'items',
  'properties',
  'required',
  'additionalProperties',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
])
/** Documentation only — no effect on validation. */
const IGNORED = new Set(['description', 'title', 'examples', 'example', 'deprecated'])

function convert(node, name, isComponent = false) {
  if (!node || typeof node !== 'object')
    return 'z.unknown()'

  for (const key of Object.keys(node)) {
    if (!HANDLED.has(key) && !IGNORED.has(key))
      throw new Error(`gen-zod: unhandled JSON Schema keyword ${JSON.stringify(key)} in schema "${name}". Add a handler in convert() — do not ignore it, an ignored keyword silently weakens the generated schema.`)
  }

  if (node.$ref) {
    const target = node.$ref.replace('#/components/schemas/', '')
    // A build-time failure beats emitting a module that throws a TDZ
    // ReferenceError at import time on a user's Homebridge instance.
    if (target === name)
      throw new Error(`gen-zod: schema "${name}" references itself; convert() cannot emit a recursive schema. Add a z.lazy wrapper if the spec ever needs one.`)
    return idOf(target)
  }

  // `type` may be an array such as ["string", "null"] — 95 occurrences in this
  // spec. This MUST come before const/enum: several schemas are both nullable
  // and enumerated (relayOutputState and friends), and checking enum first
  // drops the .nullable() on the floor.
  if (Array.isArray(node.type)) {
    const nonNull = node.type.filter(t => t !== 'null')
    const bases = nonNull.map(t => convert({ ...node, type: t }, name))
    const base = bases.length === 1 ? bases[0] : `z.union([${bases.join(', ')}])`
    return node.type.includes('null') ? `${base}.nullable()` : base
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

  // `pattern` is JSON Schema's unanchored substring match — exactly zod's
  // `.regex()` semantics — but only on strings. A pattern anywhere else must
  // fail the build rather than be dropped.
  if (node.pattern !== undefined && node.type !== 'string')
    throw new Error(`gen-zod: "pattern" on a non-string type in schema "${name}". Add a handler in convert() — do not ignore it.`)

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
      return withArr(node, `z.array(${convert(node.items, name)})`)
    case 'object':
      return objectOf(node, name, isComponent)
    default:
      return node.properties ? objectOf(node, name, isComponent) : 'z.unknown()'
  }
}

function withStr(node, base) {
  let s = base
  if (node.minLength !== undefined)
    s += `.min(${node.minLength})`
  if (node.maxLength !== undefined)
    s += `.max(${node.maxLength})`
  if (node.pattern !== undefined)
    s += `.regex(new RegExp(${lit(node.pattern)}))`
  return s
}

function withNum(node, base) {
  let s = base
  if (node.minimum !== undefined)
    s += `.min(${node.minimum})`
  if (node.maximum !== undefined)
    s += `.max(${node.maximum})`
  // OpenAPI 3.1 follows JSON Schema 2020-12: exclusiveMinimum is a number, not
  // a boolean modifier on `minimum`. 38 occurrences, all `*Event.start`.
  if (node.exclusiveMinimum !== undefined)
    s += `.gt(${node.exclusiveMinimum})`
  return s
}

function withArr(node, base) {
  let s = base
  if (node.minItems !== undefined)
    s += `.min(${node.minItems})`
  if (node.maxItems !== undefined)
    s += `.max(${node.maxItems})`
  return s
}

function objectOf(node, name, isComponent = false) {
  const props = node.properties ?? {}
  const required = new Set(node.required ?? [])
  // Self-policing: a no-op override is the dangerous direction. If the spec ever
  // stops marking the field required, the entry must be deleted rather than left
  // to rot as a silent permanent weakening of the schema. Two guards on where
  // overrides apply:
  //  - `title` ONLY: nested anonymous objects fall back to the parent schema's
  //    `name`, which would apply the parent's overrides to every nested object.
  //  - `isComponent`: the spec re-declares inline copies of device schemas
  //    (deviceBulk, the PartialWithReference variants) under the same title —
  //    a partial variant marks almost nothing required, so an override whose
  //    purpose is relaxing a required field is meaningless there and its
  //    self-policing would fire on the partial, not on real rot.
  for (const key of isComponent ? (OPTIONAL_OVERRIDES[node.title] ?? []) : []) {
    if (!required.delete(key))
      throw new Error(`gen-zod: OPTIONAL_OVERRIDES entry ${node.title ?? name}.${key} is no longer required in the spec — delete the entry.`)
  }
  const entries = Object.entries(props).map(([key, value]) => {
    const optional = required.has(key) ? '' : '.optional()'
    return `  ${JSON.stringify(key)}: ${convert(value, name)}${optional},`
  })
  // Unknown keys are PRESERVED, not stripped. A firmware update that adds a
  // field must not silently drop it, and must never fail validation.
  const fn = node.additionalProperties === false ? 'z.strictObject' : 'z.looseObject'
  const body = entries.length ? `${fn}({\n${entries.join('\n')}\n})` : `${fn}({})`
  // A schema whose additionalProperties is itself a schema constrains the values.
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    // z.record() has no place for declared properties, so emitting one here
    // would silently discard every one of them — exactly the class of quiet
    // weakening the keyword whitelist exists to catch. No occurrence in the
    // current spec; if one appears, the generator must be taught the shape
    // rather than quietly dropping it.
    if (entries.length)
      throw new Error(`gen-zod: ${node.title ?? name} declares both properties and a schema-valued additionalProperties — z.record() cannot carry the properties. Teach the generator this shape.`)
    return `z.record(z.string(), ${convert(node.additionalProperties, name)})`
  }
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
      // A mutual $ref cycle cannot be emitted as plain const declarations: the
      // module would throw a TDZ ReferenceError at import time on a user's
      // Homebridge instance. Fail the build instead — this spec has no cycles.
      throw new Error(`gen-zod: $ref cycle among [${names.filter(n => !done.has(n)).sort().join(', ')}]. Emitting these needs z.lazy(); plain consts would TDZ at import.`)
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
  const expr = convert(schemas[n], n, true)
  // Almost every schema here is looseObject. The handful the spec closes with
  // `additionalProperties: false` behave the opposite way, and a consumer that
  // assumes otherwise will see valid payloads rejected after a firmware bump.
  const warn = expr.startsWith('z.strictObject')
    ? '// WARNING: the spec sets `additionalProperties: false` on this schema, so unlike\n// every looseObject below it REJECTS unknown fields. A newer firmware adding a\n// field here fails validation — consumers must degrade rather than throw.\n'
    : ''
  return `${warn}export const ${id} = ${expr}\nexport type ${typeName} = z.infer<typeof ${id}>\n`
}).join('\n')

writeFileSync(OUT, `// GENERATED by scripts/gen-zod.mjs from ${SPEC}. Do not edit by hand.
// Regenerate with: npm run gen:zod
/* eslint-disable */
import { z } from 'zod'

${body}`)

console.log(`wrote ${OUT} (${names.length} schemas)`)
