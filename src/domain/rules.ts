import type { CaseStatus } from './status.js'

import { isWithinDeadline } from './deadline.js'

// The terminal rules (docs/DOMAIN.md, "Terminal rules"). Predicates live here, in code, so
// they are reviewable and unit-tested. Per tenant, only the order and the on/off switch are
// data (tenant_rule_config).
//
// Rules are evaluated when something is written, never when history is read. The decision
// is stored on the event together with RULESET_VERSION, so changing anything in this file
// requires bumping the version and never changes what the system says about the past.

export const RULESET_VERSION = 1

export const CONFIGURABLE_RULE_KEYS = [
  'deadline_passed',
  'evidence_filed',
  'scheme_outcome',
] as const

export type ConfigurableRuleKey = (typeof CONFIGURABLE_RULE_KEYS)[number]

export type RuleKey = 'default_open' | ConfigurableRuleKey

export const DEFAULT_RULE_ORDER: readonly ConfigurableRuleKey[] = CONFIGURABLE_RULE_KEYS

// Everything the rules need to know about a case. The facts are derived from what has been
// recorded; nothing here is read from a clock.
export interface CaseFacts {
  deadlineAt: Date
  evidenceFiledInTime: boolean
  outcome: 'LOST' | 'WON' | null
}

export interface Decision {
  ruleKey: RuleKey
  status: CaseStatus
}

export interface RuleConfigEntry {
  enabled: boolean
  priority: number
  ruleKey: ConfigurableRuleKey
}

type Predicate = (facts: CaseFacts, now: Date) => CaseStatus | null

export class RuleConfigError extends Error {
  override name = 'RuleConfigError'
}

const PREDICATES: Readonly<Record<ConfigurableRuleKey, Predicate>> = {
  // 1. The deadline passed and the bank never answered in time. The second condition is what
  //    the brief's wording leaves out: without it, a case that filed evidence on time would be
  //    lost the day the deadline passes, before the scheme has even decided (NOTES 2.10).
  deadline_passed: (facts, now) =>
    !isWithinDeadline(now, facts.deadlineAt) && !facts.evidenceFiledInTime ? 'LOST' : null,

  // 2. Evidence was filed in time and the scheme has not decided yet.
  evidence_filed: (facts) =>
    facts.evidenceFiledInTime && facts.outcome === null ? 'UNDER_REVIEW' : null,

  // 3. The scheme decided.
  scheme_outcome: (facts) => facts.outcome,
}

// The first rule that matches decides. Predicates 2 and 3 never match together, so their
// relative order is irrelevant; the order only settles rule 1 against rule 3.
export function evaluateRules(
  facts: CaseFacts,
  now: Date,
  order: readonly ConfigurableRuleKey[] = DEFAULT_RULE_ORDER,
): Decision {
  for (const ruleKey of order) {
    const status = PREDICATES[ruleKey](facts, now)
    if (status !== null) return { ruleKey, status }
  }
  return { ruleKey: 'default_open', status: 'OPEN' }
}

// Turns a tenant's tenant_rule_config rows into an evaluation order. Rules without a row keep
// their default position after the configured ones; disabled rules are dropped.
export function resolveRuleOrder(config: readonly RuleConfigEntry[]): ConfigurableRuleKey[] {
  const seenRules = new Set<ConfigurableRuleKey>()
  const seenPriorities = new Set<number>()
  for (const entry of config) {
    if (seenRules.has(entry.ruleKey)) {
      throw new RuleConfigError(`rule configured twice: ${entry.ruleKey}`)
    }
    if (seenPriorities.has(entry.priority)) {
      throw new RuleConfigError(`priority used twice: ${entry.priority}`)
    }
    seenRules.add(entry.ruleKey)
    seenPriorities.add(entry.priority)
  }

  const configured = [...config]
    .sort((a, b) => a.priority - b.priority)
    .filter((entry) => entry.enabled)
    .map((entry) => entry.ruleKey)
  const untouched = DEFAULT_RULE_ORDER.filter((ruleKey) => !seenRules.has(ruleKey))

  return [...configured, ...untouched]
}
