// The scheme deadline.
//
// deadline_at is the end of the calendar day `presentment_date + window_days` in the time zone
// of the response window (UTC by default). Formally: the first instant of the following day
// in that zone. A moment is in time when it is strictly before deadline_at, a half-open
// interval, so an instant exactly at the deadline has one answer: too late.
//
// Calendar arithmetic is done on dates, never by adding 24-hour periods to an instant, so a
// daylight-saving change inside the window cannot move the deadline by an hour.

export class DeadlineError extends Error {
  override name = 'DeadlineError'
}

export const DEFAULT_DEADLINE_TIME_ZONE = 'UTC'

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const MS_PER_DAY = 86_400_000
const formatters = new Map<string, Intl.DateTimeFormat>()

export function addCalendarDays(isoDate: string, days: number): string {
  const { day, month, year } = parseIsoDate(isoDate)
  return toIsoDate(new Date(Date.UTC(year, month - 1, day) + days * MS_PER_DAY))
}

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

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone)
    return true
  } catch {
    return false
  }
}

// The single definition of "in time". Every caller goes through it.
export function isWithinDeadline(instant: Date, deadlineAt: Date): boolean {
  return instant.getTime() < deadlineAt.getTime()
}

export function parseIsoDate(isoDate: string): { day: number; month: number; year: number } {
  const match = DATE_PATTERN.exec(isoDate)
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new DeadlineError(`not a calendar date: ${isoDate}`)
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])

  // Round-trip through the calendar so 2026-02-30 is rejected instead of rolling over.
  if (toIsoDate(new Date(Date.UTC(year, month - 1, day))) !== isoDate) {
    throw new DeadlineError(`not a calendar date: ${isoDate}`)
  }
  return { day, month, year }
}

// The first instant of a calendar day in an IANA time zone. Where midnight does not exist
// because a daylight-saving jump skips it, this is the first instant that does.
export function startOfDayInZone(isoDate: string, timeZone: string): Date {
  const { day, month, year } = parseIsoDate(isoDate)
  const wallClock = Date.UTC(year, month - 1, day)

  let instant = wallClock - zoneOffset(wallClock, timeZone)
  instant = wallClock - zoneOffset(instant, timeZone)

  // Inside a daylight-saving gap the result lands on the previous day; step forward until
  // the wall clock reads the requested date.
  while (localIsoDate(instant, timeZone) < isoDate) {
    instant += 15 * 60_000
  }
  return new Date(instant)
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
        minute: '2-digit',
        month: '2-digit',
        second: '2-digit',
        timeZone,
        year: 'numeric',
      })
    } catch {
      throw new DeadlineError(`unknown time zone: ${timeZone}`)
    }
    formatters.set(timeZone, formatter)
  }
  return formatter
}

function localIsoDate(instant: number, timeZone: string): string {
  const parts = wallClockParts(instant, timeZone)
  return toIsoDate(new Date(Date.UTC(parts.year, parts.month - 1, parts.day)))
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function wallClockParts(
  instant: number,
  timeZone: string,
): { day: number; hour: number; minute: number; month: number; second: number; year: number } {
  const values = new Map<string, number>()
  for (const part of formatterFor(timeZone).formatToParts(new Date(instant))) {
    values.set(part.type, Number(part.value))
  }
  const read = (type: string): number => {
    const value = values.get(type)
    // Unreachable with the fixed formatter options above; a wrong date is worse than a crash.
    if (value === undefined) throw new DeadlineError(`missing ${type} for ${timeZone}`)
    return value
  }
  return {
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    month: read('month'),
    second: read('second'),
    year: read('year'),
  }
}

// Offset of the zone from UTC at an instant, in milliseconds (positive east of Greenwich).
function zoneOffset(instant: number, timeZone: string): number {
  const p = wallClockParts(instant, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(instant / 1000) * 1000
}
