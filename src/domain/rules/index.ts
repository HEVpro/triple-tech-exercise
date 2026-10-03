// Rules: the terminal rules that decide a case's status, and a tenant's order and enablement
// of them. Predicates are code; only order and on/off are data (tenant_rule_config).
// Rules are evaluated when something is written, never when history is read.

export { CONFIGURABLE_RULE_KEYS, DEFAULT_RULE_ORDER, RULESET_VERSION } from './constants.js'
export { RuleConfigError } from './errors.js'
export { evaluateRules } from './evaluate.js'
export { resolveRuleOrder } from './tenant-order.js'
export type { CaseFacts, ConfigurableRuleKey, Decision, RuleConfigEntry, RuleKey } from './types.js'
