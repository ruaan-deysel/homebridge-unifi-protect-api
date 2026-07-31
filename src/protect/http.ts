import { Buffer } from 'node:buffer'
import { request as httpsRequest } from 'node:https'

export interface HttpResponse {
  status: number
  headers: NodeJS.Dict<string | string[]>
  body: Buffer
}

export interface HttpOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

/** Injected in tests. The client depends on this type, never on node:https directly. */
export type HttpRequestFn = (url: string, options?: HttpOptions) => Promise<HttpResponse>

/**
 * Non-2xx responses resolve rather than reject — mapping status codes to typed
 * errors is the client's job, so this stays a dumb pipe.
 *
 * `fetch` is deliberately not used: it cannot skip certificate verification in
 * node without an undici dispatcher, and silently ignores an `agent` option.
 */
export const httpsRequestFn: HttpRequestFn = (url, options = {}) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
        // A local UniFi console presents a self-signed certificate for an IP
        // address, so there is no CA that could validate it. Scoped to this
        // request — never NODE_TLS_REJECT_UNAUTHORIZED, which is process-wide.
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }))
        res.on('error', reject)
      },
    )
    req.setTimeout(options.timeoutMs ?? 15_000, () => req.destroy(new Error('Request timed out')))
    req.on('error', reject)
    if (options.body)
      req.write(options.body)
    req.end()
  })
