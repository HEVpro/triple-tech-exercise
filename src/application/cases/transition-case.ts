import type { EventDraft } from '../../domain/events/index.js'
import type { CaseStore } from './ports.js'
import type { CaseRecord, Principal } from './types.js'

import { decideTransition, type TransitionRequest } from '../../domain/dispute/index.js'
import { resolveRuleOrder } from '../../domain/rules/index.js'
import { CaseError } from './errors.js'

export type TransitionInput =
  | { evidence_refs: readonly string[]; reason: string; to: 'UNDER_REVIEW' }
  | { reason: string; scheme_decided_on: string; scheme_decision_ref: string; to: 'LOST' | 'WON' }
  | { reason: string; to: 'OPEN' }

export interface TransitionResult {
  case: CaseRecord
  // null when the case was already in the requested status: nothing was written.
  event: EventDraft | null
}

// POST /cases/:id/transitions. The client asks for a status; the domain rules decide. A
// rejection names the rule that decided, and nothing is written (D-25).
export function transitionCase(
  store: CaseStore,
  principal: Principal,
  caseId: string,
  input: TransitionInput,
): Promise<TransitionResult> {
  return store.transaction(async (tx) => {
    const now = await tx.now()
    const record = await tx.caseById(principal.tenantId, caseId, { forUpdate: true })
    if (!record) throw new CaseError('case_not_found', 'case not found')

    const decision = decideTransition({
      now,
      request: toRequest(principal, input),
      ruleOrder: resolveRuleOrder(await tx.ruleConfig(record.tenant_id)),
      state: {
        deadlineAt: record.deadline_at,
        deadlineWindowDays: record.deadline_window_days,
        status: record.status,
      },
    })

    switch (decision.kind) {
      case 'accepted': {
        const { event } = decision
        if (!event.ruleKey) throw new Error('a transition event must name its rule')
        const advanced = await tx.advance(record, event.to, event.ruleKey)
        await tx.appendEvents(advanced, [{ draft: event, seq: advanced.version }])
        return { case: advanced, event }
      }
      case 'noop':
        return { case: record, event: null }
      case 'rejected':
        throw rejection(decision)
    }
  })
}

function rejection(
  decision: Extract<ReturnType<typeof decideTransition>, { kind: 'rejected' }>,
): CaseError {
  switch (decision.code) {
    case 'case_closed':
      return new CaseError('case_closed', 'the case is closed (WON or LOST) and cannot change')
    case 'not_an_action':
      return new CaseError('not_an_action', 'OPEN is the default status, not an action')
    case 'rule_conflict':
      return new CaseError(
        'rule_conflict',
        `the rules decide ${decision.decided.status} (${decision.decided.ruleKey})`,
        decision.decided,
      )
    case 'system_actor':
      // Unreachable through the API: authentication never issues a system principal.
      throw new Error('the system actor cannot request transitions')
  }
}

function toRequest(principal: Principal, input: TransitionInput): TransitionRequest {
  const { actor } = principal
  switch (input.to) {
    case 'LOST':
    case 'WON':
      return {
        actor,
        reason: input.reason,
        schemeDecidedOn: input.scheme_decided_on,
        schemeDecisionRef: input.scheme_decision_ref,
        to: input.to,
      }
    case 'OPEN':
      return { actor, reason: input.reason, to: 'OPEN' }
    case 'UNDER_REVIEW':
      return { actor, evidenceRefs: input.evidence_refs, reason: input.reason, to: 'UNDER_REVIEW' }
  }
}
