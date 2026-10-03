import type { EventDraft } from '../events/index.js'
import type { ConfigurableRuleKey } from '../rules/index.js'
import type { CaseState } from './types.js'

import { validateEventDraft } from '../events/index.js'
import { evaluateRules, RULESET_VERSION } from '../rules/index.js'
import { SYSTEM_SWEEPER } from '../shared/index.js'
import { factsFor } from './facts.js'

// The DEADLINE_EXPIRED event for an OPEN case whose deadline rule fires, or null. Shared by
// creation (a case born late) and the sweeper (a case that became late).
export function expireIfDue(input: {
  detectedBy: 'creation' | 'sweeper'
  now: Date
  ruleOrder: readonly ConfigurableRuleKey[]
  state: CaseState
  sweepRunId?: string
}): EventDraft | null {
  const { state } = input
  if (state.status !== 'OPEN') return null

  const decided = evaluateRules(factsFor(state), input.now, input.ruleOrder)
  if (decided.ruleKey !== 'deadline_passed') return null

  return validateEventDraft({
    actor: SYSTEM_SWEEPER,
    from: 'OPEN',
    metadata: {
      deadline_at: state.deadlineAt.toISOString(),
      detected_by: input.detectedBy,
      window_days: state.deadlineWindowDays,
      ...(input.sweepRunId === undefined ? {} : { sweep_run_id: input.sweepRunId }),
    },
    occurredAt: state.deadlineAt,
    reason: null,
    ruleKey: 'deadline_passed',
    rulesetVersion: RULESET_VERSION,
    to: 'LOST',
    type: 'DEADLINE_EXPIRED',
  })
}
