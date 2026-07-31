// test/queue.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProtectAuthError, ProtectRateLimitError, ProtectUnavailableError } from '../src/protect/errors.js'
import { RequestQueue } from '../src/protect/queue.js'

describe('requestQueue', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('never exceeds the configured concurrency', async () => {
    const queue = new RequestQueue({ concurrency: 2 })
    let active = 0
    let peak = 0
    const task = () => new Promise<void>((resolve) => {
      active++
      peak = Math.max(peak, active)
      setTimeout(() => {
        active--
        resolve()
      }, 10)
    })

    const all = Promise.all(Array.from({ length: 6 }, () => queue.run(task)))
    await vi.runAllTimersAsync()
    await all

    expect(peak).toBe(2)
  })

  it('never exceeds concurrency when completions trigger new submissions', async () => {
    // Regression test for a semaphore race: release() must hand a freed slot
    // directly to the next waiter instead of decrementing-then-waking, or a
    // brand-new acquire() call arriving in that gap can steal it. The prior
    // test alone can't catch this because all its tasks are submitted
    // upfront; this one resubmits from inside a completion handler (no
    // intervening await), the exact interleaving that exposes the gap.
    const queue = new RequestQueue({ concurrency: 2 })
    let active = 0
    let peak = 0
    let launched = 0
    const totalToLaunch = 20
    const task = () => new Promise<void>((resolve) => {
      active++
      peak = Math.max(peak, active)
      setTimeout(() => {
        active--
        resolve()
      }, 5)
    })

    const launchOne = (): Promise<void> => {
      if (launched >= totalToLaunch)
        return Promise.resolve()
      launched++
      return queue.run(task).then(() => launchOne())
    }
    const chains = [launchOne(), launchOne(), launchOne(), launchOne()]

    await vi.runAllTimersAsync()
    await Promise.all(chains)

    expect(peak).toBeLessThanOrEqual(2)
  })

  it('retries a retryable failure with exponential backoff', async () => {
    const queue = new RequestQueue({ concurrency: 1, maxRetries: 3, baseDelayMs: 100 })
    let attempts = 0
    const task = async () => {
      attempts++
      if (attempts < 3)
        throw new ProtectUnavailableError('boom')
      return 'ok'
    }

    const promise = queue.run(task)
    await vi.runAllTimersAsync()

    await expect(promise).resolves.toBe('ok')
    expect(attempts).toBe(3)
  })

  it('does not retry an auth error', async () => {
    const queue = new RequestQueue({ concurrency: 1, maxRetries: 3, baseDelayMs: 100 })
    let attempts = 0
    const task = async () => {
      attempts++
      throw new ProtectAuthError('bad key')
    }

    const promise = queue.run(task)
    // Attach the rejection assertion before the timers run so the promise
    // always has a handler by the time it settles — otherwise Node reports
    // an unhandled rejection despite the assertion itself passing.
    const assertion = expect(promise).rejects.toBeInstanceOf(ProtectAuthError)
    await vi.runAllTimersAsync()

    await assertion
    expect(attempts).toBe(1)
  })

  it('honours Retry-After from a rate limit error', async () => {
    const queue = new RequestQueue({ concurrency: 1, maxRetries: 2, baseDelayMs: 100 })
    let attempts = 0
    const task = async () => {
      attempts++
      if (attempts === 1)
        throw new ProtectRateLimitError('slow down', 5000)
      return 'ok'
    }

    const promise = queue.run(task)
    await vi.advanceTimersByTimeAsync(4999)
    expect(attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(2)
    await expect(promise).resolves.toBe('ok')
  })

  it('gives up after maxRetries and rejects with the last error', async () => {
    const queue = new RequestQueue({ concurrency: 1, maxRetries: 2, baseDelayMs: 10 })
    const task = async () => {
      throw new ProtectUnavailableError('always down')
    }

    const promise = queue.run(task)
    const assertion = expect(promise).rejects.toBeInstanceOf(ProtectUnavailableError)
    await vi.runAllTimersAsync()

    await assertion
  })
})
