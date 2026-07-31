import type { Buffer } from 'node:buffer'
import type { HttpRequestFn } from './http.js'
import type { RequestQueueOptions } from './queue.js'
import { z } from 'zod'
import {
  ProtectAuthError,
  ProtectError,
  ProtectNotFoundError,
  ProtectRateLimitError,
  ProtectUnavailableError,
} from './errors.js'
import { httpsRequestFn } from './http.js'
import { RequestQueue } from './queue.js'
import {
  cameraSchema,
  chimeSchema,
  createdRtspsStreamsSchema,
  existingRtspsStreamsSchema,
  lightSchema,
  liveviewSchema,
  nvrSchema,
  sensorSchema,
  talkbackSessionSchema,
  viewerSchema,
} from './schemas.js'

/** Structurally compatible with Homebridge's `Logging`, without importing it. */
export interface ProtectLogger {
  debug: (message: string, ...params: unknown[]) => void
  info: (message: string, ...params: unknown[]) => void
  warn: (message: string, ...params: unknown[]) => void
  error: (message: string, ...params: unknown[]) => void
}

export interface ProtectClientOptions {
  host: string
  apiKey: string
  log?: ProtectLogger
  /** Injected in tests. Defaults to the node:https transport. */
  httpRequest?: HttpRequestFn
  queue?: RequestQueueOptions
  timeoutMs?: number
}

/** Appended to `https://{host}` — the Protect Integration API lives behind the console proxy. */
const API_BASE_PATH = '/proxy/protect/integration'

const noopLog: ProtectLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** `/v1/meta/info` is the one endpoint the spec declares inline, so it has no generated schema. */
const metaInfoSchema = z.looseObject({ applicationVersion: z.string() })

export type ChannelQuality = 'high' | 'medium' | 'low' | 'package'

export class ProtectClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly log: ProtectLogger
  private readonly httpRequest: HttpRequestFn
  private readonly queue: RequestQueue
  private readonly timeoutMs: number
  /** Schema drift is permanent for a session; warning once per message keeps the log usable. */
  private readonly warned = new Set<string>()

  constructor(options: ProtectClientOptions) {
    this.baseUrl = `https://${options.host}${API_BASE_PATH}`
    this.apiKey = options.apiKey
    this.log = options.log ?? noopLog
    this.httpRequest = options.httpRequest ?? httpsRequestFn
    this.queue = new RequestQueue(options.queue)
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  getMetaInfo(): Promise<z.infer<typeof metaInfoSchema>> {
    return this.getValidated(metaInfoSchema, '/v1/meta/info')
  }

  getCameras(): Promise<z.infer<typeof cameraSchema>[]> {
    return this.getValidatedList(cameraSchema, '/v1/cameras')
  }

  getCamera(id: string): Promise<z.infer<typeof cameraSchema>> {
    return this.getValidated(cameraSchema, `/v1/cameras/${encodeURIComponent(id)}`)
  }

  getLights(): Promise<z.infer<typeof lightSchema>[]> {
    return this.getValidatedList(lightSchema, '/v1/lights')
  }

  getSensors(): Promise<z.infer<typeof sensorSchema>[]> {
    return this.getValidatedList(sensorSchema, '/v1/sensors')
  }

  getChimes(): Promise<z.infer<typeof chimeSchema>[]> {
    return this.getValidatedList(chimeSchema, '/v1/chimes')
  }

  getViewers(): Promise<z.infer<typeof viewerSchema>[]> {
    return this.getValidatedList(viewerSchema, '/v1/viewers')
  }

  getLiveviews(): Promise<z.infer<typeof liveviewSchema>[]> {
    return this.getValidatedList(liveviewSchema, '/v1/liveviews')
  }

  /** `GET /v1/nvrs` returns a single object, not an array. */
  getNvr(): Promise<z.infer<typeof nvrSchema>> {
    return this.getValidated(nvrSchema, '/v1/nvrs')
  }

  /** Existing streams — qualities are nullable until a stream has been created. */
  getRtspsStream(id: string): Promise<z.infer<typeof existingRtspsStreamsSchema>> {
    return this.getValidated(existingRtspsStreamsSchema, `/v1/cameras/${encodeURIComponent(id)}/rtsps-stream`)
  }

  /** Enables streams for the given qualities. Different response schema to the GET. */
  async createRtspsStream(id: string, qualities: ChannelQuality[]): Promise<z.infer<typeof createdRtspsStreamsSchema>> {
    const path = `/v1/cameras/${encodeURIComponent(id)}/rtsps-stream`
    return this.validate(createdRtspsStreamsSchema, await this.getJson(path, 'POST', { qualities }), path)
  }

  async createTalkbackSession(id: string): Promise<z.infer<typeof talkbackSessionSchema>> {
    const path = `/v1/cameras/${encodeURIComponent(id)}/talkback-session`
    return this.validate(talkbackSessionSchema, await this.getJson(path, 'POST'), path)
  }

  async patchCamera(id: string, patch: Record<string, unknown>): Promise<z.infer<typeof cameraSchema>> {
    const path = `/v1/cameras/${encodeURIComponent(id)}`
    return this.validate(cameraSchema, await this.getJson(path, 'PATCH', patch), path)
  }

  /** Raw `image/jpeg` bytes — never JSON-parsed. */
  async getSnapshot(id: string, options: { highQuality?: boolean, channel?: string } = {}): Promise<Buffer> {
    const query = new URLSearchParams()
    if (options.highQuality !== undefined)
      query.set('highQuality', String(options.highQuality))
    if (options.channel !== undefined)
      query.set('channel', options.channel)
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    const response = await this.send(`/v1/cameras/${encodeURIComponent(id)}/snapshot${suffix}`)
    return response.body
  }

  private async getValidated<S extends z.ZodType>(schema: S, path: string): Promise<z.infer<S>> {
    return this.validate(schema, await this.getJson(path), path)
  }

  private async getValidatedList<S extends z.ZodType>(schema: S, path: string): Promise<z.infer<S>[]> {
    const payload = await this.getJson(path)
    if (!Array.isArray(payload)) {
      this.warnOnce(`${path}: expected a list but the console returned ${typeof payload}. Ignoring.`)
      return []
    }
    // Validated per item so one malformed device does not discard the rest.
    return payload.map(item => this.validate(schema, item, path))
  }

  /**
   * Validation degrades, never throws: a firmware update that reshapes a field
   * must not take the plugin down. The raw payload is returned instead, which
   * is load-bearing for the two `strictObject` RTSPS schemas — the only place
   * in the API where an unknown field fails validation.
   */
  private validate<S extends z.ZodType>(schema: S, payload: unknown, path: string): z.infer<S> {
    const result = schema.safeParse(payload)
    if (result.success)
      return result.data
    const detail = result.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    this.warnOnce(`${path}: response did not match the expected schema (${detail}). Using the raw payload — update the plugin if something misbehaves.`)
    return payload as z.infer<S>
  }

  private warnOnce(message: string): void {
    if (this.warned.has(message))
      return
    this.warned.add(message)
    this.log.warn(this.redact(message))
  }

  private async getJson(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const response = await this.send(path, method, body)
    if (response.body.length === 0)
      return undefined
    try {
      return JSON.parse(response.body.toString('utf8'))
    }
    catch (error) {
      throw new ProtectUnavailableError(`${method} ${path} returned a malformed JSON body`, error)
    }
  }

  private send(path: string, method = 'GET', body?: unknown) {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    return this.queue.run(async () => {
      let response
      try {
        response = await this.httpRequest(`${this.baseUrl}${path}`, {
          method,
          headers: {
            'X-API-KEY': this.apiKey,
            'Accept': 'application/json',
            ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: payload,
          timeoutMs: this.timeoutMs,
        })
      }
      catch (error) {
        throw new ProtectUnavailableError(this.redact(`${method} ${path} failed: ${errorMessage(error)}`), error)
      }
      if (response.status >= 200 && response.status < 300)
        return response
      throw this.toError(response.status, response.headers, method, path)
    })
  }

  private toError(status: number, headers: NodeJS.Dict<string | string[]>, method: string, path: string): ProtectError {
    const where = this.redact(`${method} ${path}`)
    switch (status) {
      case 401:
      case 403:
        return new ProtectAuthError(`${where}: rejected (${status}). Check the API key in UniFi Site Manager → Integrations.`)
      case 404:
        return new ProtectNotFoundError(`${where}: not found (404)`)
      case 429:
        return new ProtectRateLimitError(`${where}: rate limited (429)`, retryAfterMs(headers['retry-after']))
      default:
        if (status >= 500)
          return new ProtectUnavailableError(`${where}: console unavailable (${status})`)
        return new ProtectError(`${where}: request failed (${status})`)
    }
  }

  /** Belt and braces — nothing is expected to carry the key, but nothing may leak it either. */
  private redact(text: string): string {
    return this.apiKey.length > 0 ? text.split(this.apiKey).join('***') : text
  }
}

/** `Retry-After` is in seconds. A non-numeric value (an HTTP-date) is ignored. */
function retryAfterMs(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header
  if (raw === undefined)
    return undefined
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
