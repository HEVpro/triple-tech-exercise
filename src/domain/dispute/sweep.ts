import type { EventDraft } from '../events/index.js'
import type { ConfigurableRuleKey } from '../rules/index.js'
import type { CaseState } from './types.js'

import { DEFAULT_RULE_ORDER } from '../rules/index.js'
import { expireIfDue } from './expire.js'

// What the deadline sweeper records for one case, or null when there is nothing to record.
export function decideSweep(input: {
  now: Date
  ruleOrder?: readonly ConfigurableRuleKey[]
  state: CaseState
  sweepRunId: string
}): EventDraft | null {
  return expireIfDue({
    detectedBy: 'sweeper',
    now: input.now,
    ruleOrder: input.ruleOrder ?? DEFAULT_RULE_ORDER,
    state: input.state,
    sweepRunId: input.sweepRunId,
  })
}
