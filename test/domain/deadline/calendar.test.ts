import { describe, expect, it } from 'vitest'

import {
  addCalendarDays,
  DeadlineError,
  isValidTimeZone,
  parseIsoDate,
  startOfDayInZone,
} from '../../../src/domain/deadline/index.js'

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

  it('starts the day at the first instant that exists when midnight is skipped', () => {
    // Chile moves its clocks forward at midnight, so 00:00 does not exist that day.
    for (const date of ['2026-09-06', '2027-09-05']) {
      const start = startOfDayInZone(date, 'America/Santiago')
      expect(localDate(start, 'America/Santiago')).toBe(date)
      expect(localDate(new Date(start.getTime() - 1), 'America/Santiago')).not.toBe(date)
    }
  })

  it('knows which time zones exist', () => {
    expect(isValidTimeZone('Europe/Madrid')).toBe(true)
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
  })
})
