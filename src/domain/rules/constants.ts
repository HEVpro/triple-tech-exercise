import type { ConfigurableRuleKey } from './types.js'

// Bump on any change to a predicate or to the default order. The version is stored on every
// event a rule decides, so a change here never alters what history says about the past.
export const RULESET_VERSION = 1

export const CONFIGURABLE_RULE_KEYS = [
  'deadline_passed',
  'evidence_filed',
  'scheme_outcome',
] as const

export const DEFAULT_RULE_ORDER: readonly ConfigurableRuleKey[] = CONFIGURABLE_RULE_KEYS
