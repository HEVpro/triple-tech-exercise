import type { CaseFacts, ConfigurableRuleKey, Decision } from './types.js'

import { DEFAULT_RULE_ORDER } from './constants.js'
import { PREDICATES } from './predicates.js'

// The first rule that matches decides; if none does, the case is OPEN. Predicates 2 and 3
// never match together, so their relative order is irrelevant: the order only settles rule 1
// against rule 3.
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
