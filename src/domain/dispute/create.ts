import type { EventDraft } from '../events/index.js'
import type { ConfigurableRuleKey } from '../rules/index.js'
import type { Actor } from '../shared/index.js'

import { validateEventDraft } from '../events/index.js'
import { DEFAULT_RULE_ORDER, RULESET_VERSION } from '../rules/index.js'
import { DisputeError } from './errors.js'
import { expireIfDue } from './expire.js'

// A new case is OPEN. If its deadline has already passed when it is created, the rules decide
// that in the same breath, so the result does not depend on when the sweeper next runs
// (review scenario 2, D-28).
export function decideCreation(input: {
  actor: Actor
  deadlineAt: Date
  deadlineWindowDays: number
  now: Date
  reason: null | string
  ruleOrder?: readonly ConfigurableRuleKey[]
}): EventDraft[] {
  if (input.actor.type === 'system') {
    throw new DisputeError('a case is created by a human or an agent, never by the system')
  }

  const created = validateEventDraft({
    actor: input.actor,
    from: null,
    metadata: { source: 'api' },
    occurredAt: null,
    reason: input.reason,
    ruleKey: 'default_open',
    rulesetVersion: RULESET_VERSION,
    to: 'OPEN',
    type: 'CASE_CREATED',
  })

  const expiry = expireIfDue({
    detectedBy: 'creation',
    now: input.now,
    ruleOrder: input.ruleOrder ?? DEFAULT_RULE_ORDER,
    state: {
      deadlineAt: input.deadlineAt,
      deadlineWindowDays: input.deadlineWindowDays,
      status: 'OPEN',
    },
  })

  return expiry ? [created, expiry] : [created]
}
