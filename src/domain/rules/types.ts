import type { CaseStatus } from '../shared/index.js'
import type { CONFIGURABLE_RULE_KEYS } from './constants.js'

// Everything the rules need to know about a case. The facts are derived from what has been
// recorded; nothing here is read from a clock.
export interface CaseFacts {
  deadlineAt: Date
  evidenceFiledInTime: boolean
  outcome: 'LOST' | 'WON' | null
}

export type ConfigurableRuleKey = (typeof CONFIGURABLE_RULE_KEYS)[number]

export interface Decision {
  ruleKey: RuleKey
  status: CaseStatus
}

export type Predicate = (facts: CaseFacts, now: Date) => CaseStatus | null

// One tenant_rule_config row.
export interface RuleConfigEntry {
  priority: number
  ruleKey: ConfigurableRuleKey
}

export type RuleKey = 'default_open' | ConfigurableRuleKey
