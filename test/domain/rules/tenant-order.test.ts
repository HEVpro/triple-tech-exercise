import { describe, expect, it } from 'vitest'

import {
  DEFAULT_RULE_ORDER,
  resolveRuleOrder,
  RuleConfigError,
} from '../../../src/domain/rules/index.js'

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
