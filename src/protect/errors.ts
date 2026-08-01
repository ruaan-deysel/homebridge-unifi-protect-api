/** Base class so callers can `instanceof ProtectError` for any client failure. */
export class ProtectError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = new.target.name
  }
}

/** 401/403. The API key is invalid or revoked. Never retried. */
export class ProtectAuthError extends ProtectError {}

/** 404. The requested device no longer exists in Protect. */
export class ProtectNotFoundError extends ProtectError {}

/** 429. Includes the server-supplied retry delay when present. */
export class ProtectRateLimitError extends ProtectError {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message)
  }
}

/** 5xx, network failure, or timeout. Retryable. */
export class ProtectUnavailableError extends ProtectError {}

/** True for errors where retrying can plausibly succeed. */
export function isRetryable(error: unknown): boolean {
  return error instanceof ProtectRateLimitError || error instanceof ProtectUnavailableError
}

/**
 * The message and nothing else. Callers must never log the error *object* —
 * `util.inspect`, which is what `log.error(err)` uses, walks its properties and
 * has printed the API key from a request context before.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
