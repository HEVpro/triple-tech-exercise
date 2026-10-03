import type { EventDraft, RecordedEvent } from '../events/index.js'
import type { Decision, RuleKey } from '../rules/index.js'
import type { Actor, CaseStatus } from '../shared/index.js'

// What a dispute case is, for the purpose of deciding what happens to it next. The projection
// row carries more (money, scheme, references); none of it affects a decision.
export interface CaseState {
  deadlineAt: Date
  deadlineWindowDays: number
  status: CaseStatus
}

// A case reconstructed from its log at an instant (GET /cases/:id/history).
export interface HistoryView {
  decidedBy: { ruleKey: RuleKey; rulesetVersion: number; seq: number } | null
  events: RecordedEvent[]
  state: { status: CaseStatus; version: number } | null
  truncated: boolean
}

export type TransitionDecision =
  | { code: 'case_closed'; kind: 'rejected' }
  | { code: 'not_an_action'; kind: 'rejected' }
  | { code: 'rule_conflict'; decided: Decision; kind: 'rejected' }
  | { code: 'system_actor'; kind: 'rejected' }
  | { event: EventDraft; kind: 'accepted' }
  | { kind: 'noop' }

// POST /cases/:id/transitions, in domain terms. `to` keeps the brief's vocabulary; the
// payload is the fact that justifies it.
export type TransitionRequest =
  | { actor: Actor; reason: null | string; to: 'OPEN' }
  | {
      actor: Actor
      evidenceRefs: readonly string[]
      reason: null | string
      to: 'UNDER_REVIEW'
    }
  | {
      actor: Actor
      reason: null | string
      schemeDecidedOn: string
      schemeDecisionRef: string
      to: 'LOST' | 'WON'
    }
