import { describe, expect, it } from 'vitest'

import { addCalendarDays, computeDeadline } from '../../../src/domain/deadline/index.js'
import { decideCreation } from '../../../src/domain/dispute/index.js'
import { analyst, deadlineAt, now, today } from './fixtures.js'

describe('review scenarios at the domain level', () => {
  it('1. Visa, presented 40 days ago: about five days left, not expired', () => {
    const deadline = computeDeadline(addCalendarDays(today, -40), 45)
    const hoursLeft = (deadline.getTime() - now.getTime()) / 3_600_000

    expect(hoursLeft).toBeGreaterThan(5 * 24)
    expect(hoursLeft).toBeLessThan(6 * 24)
    const events = decideCreation({
      actor: analyst,
      deadlineAt: deadline,
      deadlineWindowDays: 45,
      now,
      reason: null,
    })
    expect(events.map((e) => e.to)).toEqual(['OPEN'])
  })

  it('2. Mastercard, presented 50 days ago: lost the moment it is created', () => {
    const deadline = computeDeadline(addCalendarDays(today, -50), 45)
    const events = decideCreation({
      actor: analyst,
      deadlineAt: deadline,
      deadlineWindowDays: 45,
      now,
      reason: null,
    })

    expect(events.map((e) => [e.type, e.to, e.ruleKey])).toEqual([
      ['CASE_CREATED', 'OPEN', 'default_open'],
      ['DEADLINE_EXPIRED', 'LOST', 'deadline_passed'],
    ])
    expect(events[1]?.occurredAt).toEqual(deadline)
    expect(events[1]?.actor.type).toBe('system')
    expect(events[1]?.metadata).toMatchObject({ detected_by: 'creation', window_days: 45 })
  })
})

describe('creating a case', () => {
  it('is never done by the system', () => {
    expect(() =>
      decideCreation({
        actor: { id: 'sweeper', type: 'system' },
        deadlineAt,
        deadlineWindowDays: 45,
        now,
        reason: null,
      }),
    ).toThrow(/never by the system/)
  })
})
