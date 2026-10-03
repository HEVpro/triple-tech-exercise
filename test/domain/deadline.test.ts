import { describe, expect, it } from 'vitest'

import {
  addCalendarDays,
  computeDeadline,
  DeadlineError,
  isValidTimeZone,
  isWithinDeadline,
  parseIsoDate,
  startOfDayInZone,
} from '../../src/domain/deadline.js'

function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(instant)
}

describe('calendar arithmetic', () => {
  it('adds days across month and leap-year boundaries', () => {
    expect(addCalendarDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addCalendarDays('2026-12-31', 45)).toBe('2027-02-14')
  })

  it('rejects anything that is not a real calendar date', () => {
    expect(() => parseIsoDate('2026-02-30')).toThrow(DeadlineError)
    expect(() => parseIsoDate('2026-2-3')).toThrow(DeadlineError)
    expect(() => parseIsoDate('03/10/2026')).toThrow(DeadlineError)
  })
})

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

  it('starts the day at the first instant that exists when midnight is skipped', () => {
    // Chile moves its clocks forward at midnight, so 00:00 does not exist that day.
    for (const date of ['2026-09-06', '2027-09-05']) {
      const start = startOfDayInZone(date, 'America/Santiago')
      expect(localDate(start, 'America/Santiago')).toBe(date)
      expect(localDate(new Date(start.getTime() - 1), 'America/Santiago')).not.toBe(date)
    }
  })

  it('rejects an unusable window or time zone', () => {
    expect(() => computeDeadline('2026-01-01', 0)).toThrow(DeadlineError)
    expect(() => computeDeadline('2026-01-01', 1.5)).toThrow(DeadlineError)
    expect(() => computeDeadline('2026-01-01', 45, 'Mars/Olympus')).toThrow(/unknown time zone/)
    expect(isValidTimeZone('Europe/Madrid')).toBe(true)
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
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
