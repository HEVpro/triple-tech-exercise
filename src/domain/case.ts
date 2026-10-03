import type { Actor, EventDraft, RecordedEvent } from './events.js'

import { isWithinDeadline } from './deadline.js'
import { SYSTEM_SWEEPER, validateEventDraft } from './events.js'
import {
  type CaseFacts,
  type ConfigurableRuleKey,
  type Decision,
  DEFAULT_RULE_ORDER,
  evaluateRules,
  type RuleKey,
  RULESET_VERSION,
} from './rules.js'
import { type CaseStatus, isTerminal } from './status.js'

// What a case is, for the purpose of deciding what happens to it next. The projection row
// carries more (money, scheme, references); none of it affects a decision.
export interface CaseState {
  deadlineAt: Date
  deadlineWindowDays: number
  status: CaseStatus
}

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

export const HISTORY_EVENT_CAP = 50_000

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
    throw new Error('a case is created by a human or an agent, never by the system')
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

export function decideNote(input: { actor: Actor; state: CaseState; text: string }): EventDraft {
  if (input.actor.type === 'system') {
    throw new Error('notes are written by a human or an agent')
  }
  return validateEventDraft({
    actor: input.actor,
    from: input.state.status,
    metadata: { text: input.text },
    occurredAt: null,
    reason: null,
    ruleKey: null,
    rulesetVersion: null,
    to: input.state.status,
    type: 'NOTE_ADDED',
  })
}

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

// Reconstructs a case as the record stood at `asOf`. It folds the stored statuses in seq
// order and never evaluates a rule, so neither a code change nor a tenant's rule
// configuration can change what this returns for a past instant (D-11).
export function foldHistory(
  events: readonly RecordedEvent[],
  asOf: Date,
  cap: number = HISTORY_EVENT_CAP,
): HistoryView {
  const visible = events
    .filter((event) => event.recordedAt.getTime() <= asOf.getTime())
    .sort((a, b) => a.seq - b.seq)
  const truncated = visible.length > cap
  const kept = truncated ? visible.slice(0, cap) : visible

  const last = kept.at(-1)
  if (!last) return { decidedBy: null, events: [], state: null, truncated: false }

  // Every event but a note names the rule that decided it, and the first event of a case is
  // never a note, so for a real log a deciding event always exists.
  const deciding = kept.findLast(
    (event): event is Exclude<RecordedEvent, { type: 'NOTE_ADDED' }> => event.type !== 'NOTE_ADDED',
  )
  return {
    decidedBy: deciding
      ? { ruleKey: deciding.ruleKey, rulesetVersion: deciding.rulesetVersion, seq: deciding.seq }
      : null,
    events: kept,
    state: { status: last.to, version: last.seq },
    truncated,
  }
}

// Invariant 3: the projection agrees with the log. Used by tests and by the per-tenant
// verification in the migration plan.
export function projectionMatchesLog(
  projection: { status: CaseStatus; version: number },
  events: readonly RecordedEvent[],
): boolean {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  const gapless = sorted.every((event, index) => event.seq === index + 1)
  const last = sorted.at(-1)
  return gapless && last?.to === projection.status && last.seq === projection.version
}

function expireIfDue(input: {
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

// Facts follow from the status, because the status was itself decided from the facts:
// UNDER_REVIEW can only be reached by filing evidence in time, and terminal states never
// reach this function.
function factsFor(state: CaseState): CaseFacts {
  return {
    deadlineAt: state.deadlineAt,
    evidenceFiledInTime: state.status === 'UNDER_REVIEW',
    outcome: null,
  }
}
