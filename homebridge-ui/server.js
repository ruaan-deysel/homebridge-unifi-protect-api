import { Buffer } from 'node:buffer'
import { request as httpsRequest } from 'node:https'
import process from 'node:process'
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils'

const fail = message => new RequestError(message, {})

function baseUrl(host) {
  const trimmed = typeof host === 'string' ? host.trim() : ''
  if (!trimmed)
    throw fail('Enter the IP address or hostname of your UniFi console.')
  return `https://${trimmed}/proxy/protect/integration/v1`
}

/**
 * Minimal fetch-shaped wrapper over node:https.
 *
 * `fetch` is deliberately not used: it cannot skip certificate verification
 * in node without an undici dispatcher, and silently ignores an `agent`
 * option — the console's self-signed cert makes that a hard blocker (the
 * same reasoning behind src/protect/http.ts). This is inlined rather than
 * imported from ../dist/ because server.js is plain JS loaded outside the TS
 * build, and the shim needed here is a handful of lines — not worth coupling
 * the UI server to build output existing/being current.
 */
function httpsFetch(url, { headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { headers, rejectUnauthorized: false }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const status = res.statusCode ?? 0
        resolve({
          status,
          ok: status >= 200 && status < 300,
          json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'),
        })
      })
      res.on('error', reject)
    })
    req.setTimeout(15_000, () => req.destroy(new Error('Request timed out')))
    req.on('error', reject)
    req.end()
  })
}

async function get(path, payload, deps) {
  const { host, apiKey } = payload
  // Resolved before the network attempt, so a missing host fails without
  // ever touching fetchImpl.
  const url = `${baseUrl(host)}${path}`
  const fetchImpl = deps?.fetchImpl ?? httpsFetch

  let response
  try {
    // Never log apiKey — it is sent only as the X-API-KEY header value.
    response = await fetchImpl(url, { headers: { 'X-API-KEY': apiKey ?? '' } })
  }
  catch {
    throw fail(`Could not reach ${host}. Check the address, and that the console is on and reachable from Homebridge.`)
  }

  if (response.status === 401 || response.status === 403)
    throw fail('That API key was rejected. Create one in UniFi Site Manager → Integrations, and make sure it has Protect access.')
  if (response.status === 404)
    throw fail(`${host} responded, but the Protect Integration API is not there. Check that UniFi Protect is installed and up to date.`)
  if (!response.ok)
    throw fail(`The console returned ${response.status}. Try again shortly.`)
  return response.json()
}

export async function testConnectionRequest(payload = {}, deps) {
  const info = await get('/meta/info', payload, deps)
  const nvr = await get('/nvrs', payload, deps)
  return { version: info.applicationVersion, nvrName: nvr?.name ?? 'UniFi Protect' }
}

export async function discoverRequest(payload = {}, deps) {
  const [cameras, lights, sensors, chimes] = await Promise.all([
    get('/cameras', payload, deps),
    get('/lights', payload, deps),
    get('/sensors', payload, deps),
    get('/chimes', payload, deps),
  ])

  const slim = (device, type) => ({
    id: device.id,
    name: device.name,
    type,
    hasSpeaker: device.featureFlags?.hasSpeaker ?? false,
    hasLedStatus: device.featureFlags?.hasLedStatus ?? false,
    hasPackageCamera: device.hasPackageCamera ?? false,
    smartDetectTypes: device.featureFlags?.smartDetectTypes ?? [],
  })

  return {
    devices: [
      ...cameras.map(d => slim(d, 'camera')),
      ...lights.map(d => slim(d, 'light')),
      ...sensors.map(d => slim(d, 'sensor')),
      ...chimes.map(d => slim(d, 'chime')),
    ],
  }
}

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super()
    this.onRequest('/test-connection', payload => testConnectionRequest(payload))
    this.onRequest('/discover', payload => discoverRequest(payload))
    this.ready()
  }
}

// Only start a server when spawned by Homebridge (a child process talking
// over IPC), never on a plain module import — that's how the test suite
// loads these handlers directly.
if (process.send && process.env.NODE_ENV !== 'test')
  void new UiServer()
