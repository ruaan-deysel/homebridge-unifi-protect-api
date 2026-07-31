import { isRetryable, ProtectRateLimitError } from './errors.js'

export interface RequestQueueOptions {
  /** Maximum simultaneous in-flight tasks. The console returns 429 under burst load. */
  concurrency?: number
  maxRetries?: number
  baseDelayMs?: number
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Serialises access to the Protect console. Every request goes through here so a
 * burst throttles itself instead of tripping the rate limiter.
 */
export class RequestQueue {
  private readonly concurrency: number
  private readonly maxRetries: number
  private readonly baseDelayMs: number
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(options: RequestQueueOptions = {}) {
    this.concurrency = options.concurrency ?? 4
    this.maxRetries = options.maxRetries ?? 3
    this.baseDelayMs = options.baseDelayMs ?? 500
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await this.attempt(task)
    }
    finally {
      this.release()
    }
  }

  private async attempt<T>(task: () => Promise<T>): Promise<T> {
    // Retries run here, inside the concurrency slot acquired by run(), not by
    // re-queuing the task. This deliberately holds the slot for the whole
    // backoff chain: with concurrency: 1 and a long run of real Retry-After
    // delays, every other queued request waits out the full chain too. That
    // is the intended tradeoff, not an oversight — a 429/503 means the
    // console is telling us to back off, so releasing the slot and letting a
    // fresh request in would likely just draw a second throttle response.
    // Retrying in place also preserves submission order: a retrying request
    // keeps its spot instead of letting newer requests cut in front of it.
    let lastError: unknown
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await task()
      }
      catch (error) {
        lastError = error
        if (!isRetryable(error) || attempt === this.maxRetries)
          throw error
        const serverDelay = error instanceof ProtectRateLimitError ? error.retryAfterMs : undefined
        await sleep(serverDelay ?? this.baseDelayMs * 2 ** attempt)
      }
    }
    // Unreachable: the loop above always returns or throws on its final
    // iteration (attempt === this.maxRetries forces the `throw error`
    // branch). This just satisfies TypeScript's control-flow analysis for
    // the return type — it is not live give-up logic.
    throw lastError
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++
      return
    }
    // Handed a slot directly by release() below — active is already
    // accounted for, so no increment here. Incrementing again would
    // let a fresh acquire() steal the slot in the gap between
    // release()'s decrement and this continuation running.
    await new Promise<void>(resolve => this.waiting.push(resolve))
  }

  private release(): void {
    // Hand the freed slot directly to the next waiter instead of
    // decrementing-then-waking: decrementing first leaves a window,
    // between the decrement and the waiter's continuation actually
    // running (a separate microtask tick), during which a brand-new
    // acquire() call could see room and steal the slot that was meant
    // for the waiter — pushing active above `concurrency`.
    const next = this.waiting.shift()
    if (next) {
      next()
      return
    }
    this.active--
  }
}
