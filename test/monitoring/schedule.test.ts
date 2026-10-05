import { describe, expect, it } from 'vitest'

import { scheduleConfig, watchSchedule } from '../../src/monitoring/index.js'

const sweeper = { alertAfterMinutes: 15, maxRuntimeMinutes: 5 }

describe('watching a scheduled task', () => {
  it('expects a run every minute and alerts after 15 minutes without a successful one', () => {
    expect(scheduleConfig({ ...sweeper, everyMs: 60_000 })).toMatchObject({
      failureIssueThreshold: 15,
      maxRuntime: 5,
      schedule: { type: 'interval', unit: 'minute', value: 1 },
    })
  })

  it('keeps the 15 minutes when the task runs less often', () => {
    expect(scheduleConfig({ ...sweeper, everyMs: 300_000 })).toMatchObject({
      failureIssueThreshold: 3,
      schedule: { value: 5 },
    })
  })

  it('never schedules below one minute, the smallest interval the provider accepts', () => {
    expect(scheduleConfig({ ...sweeper, everyMs: 1_000 }).schedule).toMatchObject({
      unit: 'minute',
      value: 1,
    })
  })

  it('runs the task and returns its result when monitoring is not started', async () => {
    await expect(
      watchSchedule('a-task', { ...sweeper, everyMs: 60_000 }, () => Promise.resolve('done')),
    ).resolves.toBe('done')
  })

  it('lets a failing run fail', async () => {
    await expect(
      watchSchedule('a-task', { ...sweeper, everyMs: 60_000 }, () =>
        Promise.reject(new Error('database unavailable')),
      ),
    ).rejects.toThrow('database unavailable')
  })
})
