import type { EventDraft } from '../events/index.js'
import type { CaseFacts, ConfigurableRuleKey } from '../rules/index.js'
import type { CaseState, TransitionDecision, TransitionRequest } from './types.js'

import { isWithinDeadline } from '../deadline/index.js'
import { validateEventDraft } from '../events/index.js'
import { DEFAULT_RULE_ORDER, evaluateRules, RULESET_VERSION } from '../rules/index.js'
import { isTerminal } from '../shared/index.js'
import { factsFor } from './facts.js'

// The client asks for a status; the rules decide. A request whose outcome the rules do not
// confirm is rejected with the rule that decided, and nothing is written (D-25).
export function decideTransition(input: {
  now: Date
  request: TransitionRequest
  ruleOrder?: readonly ConfigurableRuleKey[]
  state: CaseState
}): TransitionDecision {
  const { now, request, state } = input
  const order = input.ruleOrder ?? DEFAULT_RULE_ORDER

  if (request.actor.type === 'system') return { code: 'system_actor', kind: 'rejected' }
  if (request.to === state.status) return { kind: 'noop' }
  if (request.to === 'OPEN') return { code: 'not_an_action', kind: 'rejected' }
  if (isTerminal(state.status)) return { code: 'case_closed', kind: 'rejected' }

  const before = factsFor(state)
  const facts: CaseFacts =
    request.to === 'UNDER_REVIEW'
      ? { ...before, evidenceFiledInTime: isWithinDeadline(now, state.deadlineAt) }
      : { ...before, outcome: request.to }

  const decided = evaluateRules(facts, now, order)
  if (decided.status !== request.to) {
    return { code: 'rule_conflict', decided, kind: 'rejected' }
  }

  const common = {
    actor: request.actor,
    from: state.status,
    occurredAt: null,
    reason: request.reason,
    ruleKey: decided.ruleKey,
    rulesetVersion: RULESET_VERSION,
    to: decided.status,
  }

  const event: EventDraft =
    request.to === 'UNDER_REVIEW'
      ? {
          ...common,
          metadata: { evidence_refs: [...request.evidenceRefs] },
          type: 'EVIDENCE_FILED',
        }
      : {
          ...common,
          metadata: {
            outcome: request.to,
            scheme_decided_on: request.schemeDecidedOn,
            scheme_decision_ref: request.schemeDecisionRef,
          },
          type: 'SCHEME_OUTCOME_RECORDED',
        }

  return { event: validateEventDraft(event), kind: 'accepted' }
}
