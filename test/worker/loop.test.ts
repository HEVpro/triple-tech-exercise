import { describe, expect, it } from 'vitest'

import { startLoop } from '../../src/worker/loop.js'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('the sweeper loop', () => {
  it('runs repeatedly and never overlaps two runs', async () => {
    let running = 0
    let maxConcurrent = 0
    let runs = 0
    const loop = startLoop({
      intervalMs: 5,
      onError: () => undefined,
      run: async () => {
        running += 1
        maxConcurrent = Math.max(maxConcurrent, running)
        await wait(15)
        running -= 1
        runs += 1
      },
    })

    await wait(100)
    await loop.stop()

    expect(runs).toBeGreaterThan(2)
    expect(maxConcurrent).toBe(1)
  })

  it('keeps going after a failed run, and reports it', async () => {
    const errors: unknown[] = []
    let calls = 0
    const loop = startLoop({
      intervalMs: 5,
      onError: (error) => errors.push(error),
      run: () => {
        calls += 1
        return calls === 1 ? Promise.reject(new Error('database down')) : Promise.resolve()
      },
    })

    await wait(50)
    await loop.stop()

    expect(errors).toHaveLength(1)
    expect(calls).toBeGreaterThan(1)
  })

  it('stop waits for the run in progress and schedules nothing after it', async () => {
    let finished = false
    let calls = 0
    const loop = startLoop({
      intervalMs: 1,
      onError: () => undefined,
      run: async () => {
        calls += 1
        await wait(30)
        finished = true
      },
    })

    await loop.stop()
    const callsAtStop = calls
    await wait(20)

    expect(finished).toBe(true)
    expect(calls).toBe(callsAtStop)
  })
})
