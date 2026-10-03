import { describe, expect, it } from 'vitest'

import { queueState } from '../../../src/domain/dispute/index.js'

const deadlineAt = new Date('2026-10-10T00:00:00.000Z')
const before = new Date(deadlineAt.getTime() - 1)

describe('where a case stands in the stuck queue', () => {
  it.each([
    ['OPEN, deadline ahead', 'OPEN', 'default_open', before, 'at_risk'],
    ['OPEN, deadline reached but not yet swept', 'OPEN', 'default_open', deadlineAt, 'breached'],
    ['LOST to the deadline', 'LOST', 'deadline_passed', deadlineAt, 'breached'],
    ['LOST by the network', 'LOST', 'scheme_outcome', deadlineAt, null],
    ['UNDER_REVIEW, before the deadline', 'UNDER_REVIEW', 'evidence_filed', before, 'responded'],
    [
      'UNDER_REVIEW, long after the deadline',
      'UNDER_REVIEW',
      'evidence_filed',
      deadlineAt,
      'responded',
    ],
    ['WON', 'WON', 'scheme_outcome', before, null],
  ] as const)('%s → %s', (_label, status, decidedByRule, now, expected) => {
    expect(queueState({ deadlineAt, decidedByRule, status }, now)).toBe(expected)
  })
})
