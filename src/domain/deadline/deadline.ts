// The scheme deadline.
//
// deadline_at is the end of the calendar day `presentment_date + window_days` in the time zone
// of the response window (UTC by default). Formally: the first instant of the following day
// in that zone. A moment is in time when it is strictly before deadline_at, a half-open
// interval, so an instant exactly at the deadline has one answer: too late.
//
// Calendar arithmetic is done on dates, never by adding 24-hour periods to an instant, so a
// daylight-saving change inside the window cannot move the deadline by an hour.

import { addCalendarDays, startOfDayInZone } from './calendar.js'
import { DeadlineError } from './errors.js'

export const DEFAULT_DEADLINE_TIME_ZONE = 'UTC'

export function computeDeadline(
  presentmentDate: string,
  windowDays: number,
  timeZone: string = DEFAULT_DEADLINE_TIME_ZONE,
): Date {
  if (!Number.isInteger(windowDays) || windowDays < 1) {
    throw new DeadlineError(`window must be a positive whole number of days: ${windowDays}`)
  }
  return startOfDayInZone(addCalendarDays(presentmentDate, windowDays + 1), timeZone)
}

// The single definition of "in time". Every caller goes through it.
export function isWithinDeadline(instant: Date, deadlineAt: Date): boolean {
  return instant.getTime() < deadlineAt.getTime()
}
