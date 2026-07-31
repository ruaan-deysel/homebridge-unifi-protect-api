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

  it('never exceeds concurrency under continuous resubmission (sanity check)', async () => {
    // NOT a regression guard for the acquire()/release() handoff race that
    // motivated rewriting those two methods (see queue.ts comments). That
    // race requires a fresh acquire() to run its fast-path check strictly
    // between release()'s decrement and the woken waiter's own increment —
    // and under Node's single microtask queue plus vitest's fake timers
    // (which fully drain microtasks between macrotask/timer callbacks),
    // nothing can land in that gap: chained resubmission via `.then()` is
    // always sequenced after the very wake-up it would need to race, and an
    // independently-scheduled timer firing on the same tick was tried
    // empirically and also could not land in the window. This test is kept
    // only as a broader concurrency sanity check under a more adversarial
    // submission pattern than the test above (which submits everything
    // upfront); it would pass identically against the pre-fix code.
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

  it('maxRetries: 0 means exactly one attempt, no retries', async () => {
    const queue = new RequestQueue({ concurrency: 1, maxRetries: 0, baseDelayMs: 10 })
    let attempts = 0
    const task = async () => {
      attempts++
      throw new ProtectUnavailableError('down')
    }

    const promise = queue.run(task)
    const assertion = expect(promise).rejects.toBeInstanceOf(ProtectUnavailableError)
    await vi.runAllTimersAsync()

    await assertion
    expect(attempts).toBe(1)
  })

  it('runs tasks in submission order under contention', async () => {
    // concurrency: 1 makes this unambiguous — only one task can be active at
    // a time, so completion order can only match the FIFO `waiting` queue's
    // admission order, never scheduling/timer tie-breaks.
    const queue = new RequestQueue({ concurrency: 1 })
    const order: number[] = []
    const mkTask = (id: number, delayMs: number) => async () => {
      await new Promise<void>(resolve => setTimeout(resolve, delayMs))
      order.push(id)
    }

    // Delays deliberately out of step with submission order — if the queue
    // ever let a later, faster task cut ahead of an earlier, slower one that
    // is still waiting, this would catch it.
    const all = Promise.all([
      queue.run(mkTask(1, 15)),
      queue.run(mkTask(2, 5)),
      queue.run(mkTask(3, 10)),
      queue.run(mkTask(4, 1)),
      queue.run(mkTask(5, 1)),
    ])
    await vi.runAllTimersAsync()
    await all

    expect(order).toEqual([1, 2, 3, 4, 5])
  })
})
