import { describe, expect, it } from 'vitest'

import {
  computeDeadline,
  DeadlineError,
  isWithinDeadline,
} from '../../../src/domain/deadline/index.js'

describe('computing the deadline', () => {
  it('is the end of day presentment + window in UTC by default', () => {
    expect(computeDeadline('2026-01-01', 45).toISOString()).toBe('2026-02-16T00:00:00.000Z')
  })

  it('follows the window time zone when a scheme anchors elsewhere', () => {
    expect(computeDeadline('2026-01-01', 45, 'Europe/Madrid').toISOString()).toBe(
      '2026-02-15T23:00:00.000Z',
    )
    expect(computeDeadline('2026-01-01', 45, 'Asia/Tokyo').toISOString()).toBe(
      '2026-02-15T15:00:00.000Z',
    )
  })

  it('does not drift by an hour when the window crosses a daylight-saving change', () => {
    // Presented in winter (UTC+1), due after the switch to summer time (UTC+2).
    expect(computeDeadline('2026-03-01', 45, 'Europe/Madrid').toISOString()).toBe(
      '2026-04-15T22:00:00.000Z',
    )
    expect(computeDeadline('2026-03-01', 45, 'America/New_York').toISOString()).toBe(
      '2026-04-16T04:00:00.000Z',
    )
  })

  it('rejects an unusable window or time zone', () => {
    expect(() => computeDeadline('2026-01-01', 0)).toThrow(DeadlineError)
    expect(() => computeDeadline('2026-01-01', 1.5)).toThrow(DeadlineError)
    expect(() => computeDeadline('2026-01-01', 45, 'Mars/Olympus')).toThrow(/unknown time zone/)
  })
})

describe('the half-open deadline interval', () => {
  const deadline = new Date('2026-02-16T00:00:00.000Z')

  it('is in time one millisecond before the deadline', () => {
    expect(isWithinDeadline(new Date(deadline.getTime() - 1), deadline)).toBe(true)
  })

  it('is late exactly at the deadline', () => {
    expect(isWithinDeadline(deadline, deadline)).toBe(false)
  })

  it('is late one millisecond after the deadline', () => {
    expect(isWithinDeadline(new Date(deadline.getTime() + 1), deadline)).toBe(false)
  })
})
