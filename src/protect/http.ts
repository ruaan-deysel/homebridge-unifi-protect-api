import { Buffer } from 'node:buffer'
import { request as httpsRequest } from 'node:https'
import { pinnedTlsOptions } from './cert.js'

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
  /**
   * PEM of the console's certificate, used as the only trust anchor for this
   * request. Optional in the type because `HttpOptions` also describes plain
   * method/header calls, but the transport REFUSES to send anything without it.
   */
  consoleCert?: string
}

/** Injected in tests. The client depends on this type, never on node:https directly. */
export type HttpRequestFn = (url: string, options?: HttpOptions) => Promise<HttpResponse>

/**
 * Non-2xx responses resolve rather than reject — mapping status codes to typed
 * errors is the client's job, so this stays a dumb pipe.
 *
 * `fetch` is deliberately not used: it cannot be given a custom trust anchor in
 * node without an undici dispatcher, and silently ignores an `agent` option —
 * so it cannot talk to the console's self-signed certificate at all.
 */
export const httpsRequestFn: HttpRequestFn = (url, options = {}) =>
  new Promise((resolve, reject) => {
    // Fail closed. Without a pinned certificate this request could only be sent
    // by disabling verification, and the headers carry the API key — so it is
    // not sent at all. The platform pins before it makes any request.
    if (!options.consoleCert) {
      reject(new Error('Refusing to send a request before the console\'s certificate has been trusted.'))
      return
    }
    const req = httpsRequest(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
        // Pinned to the console's own certificate — see pinnedTlsOptions. Scoped
        // to this request, never NODE_TLS_REJECT_UNAUTHORIZED (process-wide).
        ...pinnedTlsOptions(options.consoleCert),
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
