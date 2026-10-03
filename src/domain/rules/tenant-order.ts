import type { ConfigurableRuleKey, RuleConfigEntry } from './types.js'

import { DEFAULT_RULE_ORDER } from './constants.js'
import { RuleConfigError } from './errors.js'

// Turns a tenant's tenant_rule_config rows into an evaluation order. Rules without a row keep
// their default position after the configured ones. Configuration changes the order only: no
// rule can be switched off (NOTES 2.23).
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
    .map((entry) => entry.ruleKey)
  const untouched = DEFAULT_RULE_ORDER.filter((ruleKey) => !seenRules.has(ruleKey))

  return [...configured, ...untouched]
}
