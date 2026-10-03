import { describe, expect, it } from 'vitest'

import {
  type CaseFacts,
  DEFAULT_RULE_ORDER,
  evaluateRules,
  resolveRuleOrder,
  RuleConfigError,
} from '../../src/domain/rules.js'

const deadlineAt = new Date('2026-02-16T00:00:00.000Z')
const before = new Date(deadlineAt.getTime() - 1)
const after = new Date(deadlineAt.getTime() + 1)

function facts(overrides: Partial<CaseFacts> = {}): CaseFacts {
  return { deadlineAt, evidenceFiledInTime: false, outcome: null, ...overrides }
}

describe('the terminal rules', () => {
  it.each([
    ['no evidence, before the deadline', facts(), before, 'OPEN', 'default_open'],
    ['no evidence, exactly at the deadline', facts(), deadlineAt, 'LOST', 'deadline_passed'],
    ['no evidence, after the deadline', facts(), after, 'LOST', 'deadline_passed'],
    [
      'evidence in time, before the deadline',
      facts({ evidenceFiledInTime: true }),
      before,
      'UNDER_REVIEW',
      'evidence_filed',
    ],
    [
      'evidence in time, after the deadline',
      facts({ evidenceFiledInTime: true }),
      after,
      'UNDER_REVIEW',
      'evidence_filed',
    ],
    [
      'evidence in time, then the scheme decides after the deadline',
      facts({ evidenceFiledInTime: true, outcome: 'WON' }),
      after,
      'WON',
      'scheme_outcome',
    ],
    [
      'the bank accepts liability before the deadline',
      facts({ outcome: 'LOST' }),
      before,
      'LOST',
      'scheme_outcome',
    ],
    [
      'no answer, deadline passed, and a WON arrives anyway',
      facts({ outcome: 'WON' }),
      after,
      'LOST',
      'deadline_passed',
    ],
  ] as const)('%s → %s', (_label, input, now, status, ruleKey) => {
    expect(evaluateRules(input, now)).toEqual({ ruleKey, status })
  })

  it('never loses a case that answered in time, however late the outcome arrives', () => {
    const muchLater = new Date('2027-06-01T00:00:00.000Z')
    expect(evaluateRules(facts({ evidenceFiledInTime: true }), muchLater).status).toBe(
      'UNDER_REVIEW',
    )
  })

  it('lets a tenant disable the automatic loss', () => {
    const order = resolveRuleOrder([{ enabled: false, priority: 1, ruleKey: 'deadline_passed' }])
    expect(evaluateRules(facts(), after, order)).toEqual({
      ruleKey: 'default_open',
      status: 'OPEN',
    })
    expect(evaluateRules(facts({ outcome: 'WON' }), after, order).status).toBe('WON')
  })
})

describe('resolving a tenant rule order', () => {
  it('is the default order when the tenant has no configuration', () => {
    expect(resolveRuleOrder([])).toEqual([...DEFAULT_RULE_ORDER])
  })

  it('puts configured rules first, by priority, and keeps the rest in default order', () => {
    expect(
      resolveRuleOrder([
        { enabled: true, priority: 2, ruleKey: 'deadline_passed' },
        { enabled: true, priority: 1, ruleKey: 'scheme_outcome' },
      ]),
    ).toEqual(['scheme_outcome', 'deadline_passed', 'evidence_filed'])
  })

  it('rejects a rule configured twice or a priority used twice', () => {
    expect(() =>
      resolveRuleOrder([
        { enabled: true, priority: 1, ruleKey: 'deadline_passed' },
        { enabled: true, priority: 2, ruleKey: 'deadline_passed' },
      ]),
    ).toThrow(RuleConfigError)
    expect(() =>
      resolveRuleOrder([
        { enabled: true, priority: 1, ruleKey: 'deadline_passed' },
        { enabled: true, priority: 1, ruleKey: 'scheme_outcome' },
      ]),
    ).toThrow(/priority used twice/)
  })
})
