import { describe, expect, it } from 'vitest'

import {
  type CaseState,
  decideCreation,
  decideNote,
  decideSweep,
  decideTransition,
  foldHistory,
  projectionMatchesLog,
  type TransitionRequest,
} from '../../src/domain/case.js'
import { addCalendarDays, computeDeadline } from '../../src/domain/deadline.js'
import { type EventDraft, type RecordedEvent } from '../../src/domain/events.js'
import { resolveRuleOrder } from '../../src/domain/rules.js'

const analyst = { id: 'analyst-1', type: 'human' } as const
const now = new Date('2026-10-03T12:00:00.000Z')
const today = '2026-10-03'

const deadlineAt = new Date('2026-10-10T00:00:00.000Z')
const beforeDeadline = new Date(deadlineAt.getTime() - 1)
const afterDeadline = new Date(deadlineAt.getTime() + 1)

function evidence(): TransitionRequest {
  return { actor: analyst, evidenceRefs: ['doc-1'], reason: null, to: 'UNDER_REVIEW' }
}

function outcome(to: 'LOST' | 'WON'): TransitionRequest {
  return {
    actor: analyst,
    reason: null,
    schemeDecidedOn: '2026-11-20',
    schemeDecisionRef: 'VROL-123',
    to,
  }
}

function state(status: CaseState['status']): CaseState {
  return { deadlineAt, deadlineWindowDays: 45, status }
}

describe('review scenarios at the domain level', () => {
  it('1. Visa, presented 40 days ago: about five days left, not expired', () => {
    const deadline = computeDeadline(addCalendarDays(today, -40), 45)
    const hoursLeft = (deadline.getTime() - now.getTime()) / 3_600_000

    expect(hoursLeft).toBeGreaterThan(5 * 24)
    expect(hoursLeft).toBeLessThan(6 * 24)
    const events = decideCreation({
      actor: analyst,
      deadlineAt: deadline,
      deadlineWindowDays: 45,
      now,
      reason: null,
    })
    expect(events.map((e) => e.to)).toEqual(['OPEN'])
  })

  it('2. Mastercard, presented 50 days ago: lost the moment it is created', () => {
    const deadline = computeDeadline(addCalendarDays(today, -50), 45)
    const events = decideCreation({
      actor: analyst,
      deadlineAt: deadline,
      deadlineWindowDays: 45,
      now,
      reason: null,
    })

    expect(events.map((e) => [e.type, e.to, e.ruleKey])).toEqual([
      ['CASE_CREATED', 'OPEN', 'default_open'],
      ['DEADLINE_EXPIRED', 'LOST', 'deadline_passed'],
    ])
    expect(events[1]?.occurredAt).toEqual(deadline)
    expect(events[1]?.actor.type).toBe('system')
    expect(events[1]?.metadata).toMatchObject({ detected_by: 'creation', window_days: 45 })
  })
})

describe('creating a case', () => {
  it('is never done by the system', () => {
    expect(() =>
      decideCreation({
        actor: { id: 'sweeper', type: 'system' },
        deadlineAt,
        deadlineWindowDays: 45,
        now,
        reason: null,
      }),
    ).toThrow(/never by the system/)
  })
})

describe('transitions: the client asks, the rules decide', () => {
  it('files evidence before the deadline', () => {
    const decision = decideTransition({
      now: beforeDeadline,
      request: evidence(),
      state: state('OPEN'),
    })
    expect(decision).toMatchObject({
      event: {
        from: 'OPEN',
        ruleKey: 'evidence_filed',
        to: 'UNDER_REVIEW',
        type: 'EVIDENCE_FILED',
      },
      kind: 'accepted',
    })
  })

  it('refuses evidence exactly at the deadline, naming the rule', () => {
    expect(
      decideTransition({ now: deadlineAt, request: evidence(), state: state('OPEN') }),
    ).toEqual({
      code: 'rule_conflict',
      decided: { ruleKey: 'deadline_passed', status: 'LOST' },
      kind: 'rejected',
    })
  })

  it('records a win that arrives after the deadline when evidence was filed in time', () => {
    const decision = decideTransition({
      now: afterDeadline,
      request: outcome('WON'),
      state: state('UNDER_REVIEW'),
    })
    expect(decision).toMatchObject({
      event: {
        metadata: { outcome: 'WON', scheme_decision_ref: 'VROL-123' },
        ruleKey: 'scheme_outcome',
        to: 'WON',
        type: 'SCHEME_OUTCOME_RECORDED',
      },
      kind: 'accepted',
    })
  })

  it('records an outcome before any evidence, e.g. the bank accepts liability', () => {
    expect(
      decideTransition({ now: beforeDeadline, request: outcome('LOST'), state: state('OPEN') }),
    ).toMatchObject({ event: { ruleKey: 'scheme_outcome', to: 'LOST' }, kind: 'accepted' })
  })

  it('refuses a win for a case that never answered and is past its deadline', () => {
    expect(
      decideTransition({ now: afterDeadline, request: outcome('WON'), state: state('OPEN') }),
    ).toMatchObject({ code: 'rule_conflict', decided: { ruleKey: 'deadline_passed' } })
  })

  it('records a loss past the deadline as decided by the deadline rule', () => {
    expect(
      decideTransition({ now: afterDeadline, request: outcome('LOST'), state: state('OPEN') }),
    ).toMatchObject({ event: { ruleKey: 'deadline_passed', to: 'LOST' }, kind: 'accepted' })
  })

  it('honours a tenant that disabled the automatic loss', () => {
    const ruleOrder = resolveRuleOrder([
      { enabled: false, priority: 1, ruleKey: 'deadline_passed' },
    ])
    expect(
      decideTransition({
        now: afterDeadline,
        request: outcome('WON'),
        ruleOrder,
        state: state('OPEN'),
      }),
    ).toMatchObject({ event: { to: 'WON' }, kind: 'accepted' })
  })

  it('treats a repeated request as a no-op, so a retry writes nothing', () => {
    expect(decideTransition({ now, request: evidence(), state: state('UNDER_REVIEW') })).toEqual({
      kind: 'noop',
    })
    expect(decideTransition({ now, request: outcome('WON'), state: state('WON') })).toEqual({
      kind: 'noop',
    })
  })

  it('rejects OPEN as a target, closed cases, and the system actor', () => {
    expect(
      decideTransition({
        now,
        request: { actor: analyst, reason: null, to: 'OPEN' },
        state: state('UNDER_REVIEW'),
      }),
    ).toEqual({ code: 'not_an_action', kind: 'rejected' })
    expect(decideTransition({ now, request: outcome('WON'), state: state('LOST') })).toEqual({
      code: 'case_closed',
      kind: 'rejected',
    })
    expect(
      decideTransition({
        now,
        request: { ...evidence(), actor: { id: 'sweeper', type: 'system' } },
        state: state('OPEN'),
      }),
    ).toEqual({ code: 'system_actor', kind: 'rejected' })
  })
})

describe('the deadline sweeper', () => {
  it('expires an OPEN case whose deadline has passed', () => {
    const event = decideSweep({ now: deadlineAt, state: state('OPEN'), sweepRunId: 'run-1' })
    expect(event).toMatchObject({
      actor: { id: 'deadline-sweeper', type: 'system' },
      metadata: { detected_by: 'sweeper', sweep_run_id: 'run-1' },
      occurredAt: deadlineAt,
      to: 'LOST',
      type: 'DEADLINE_EXPIRED',
    })
  })

  it('leaves alone a case that answered in time, one still in time, and a closed one', () => {
    expect(
      decideSweep({ now: afterDeadline, state: state('UNDER_REVIEW'), sweepRunId: 'r' }),
    ).toBeNull()
    expect(decideSweep({ now: beforeDeadline, state: state('OPEN'), sweepRunId: 'r' })).toBeNull()
    expect(decideSweep({ now: afterDeadline, state: state('LOST'), sweepRunId: 'r' })).toBeNull()
  })
})

describe('notes', () => {
  it('record work without changing the status or claiming a rule', () => {
    expect(
      decideNote({ actor: analyst, state: state('UNDER_REVIEW'), text: 'called merchant' }),
    ).toMatchObject({
      from: 'UNDER_REVIEW',
      ruleKey: null,
      rulesetVersion: null,
      to: 'UNDER_REVIEW',
      type: 'NOTE_ADDED',
    })
  })

  it('are not written by the system', () => {
    expect(() =>
      decideNote({ actor: { id: 'x', type: 'system' }, state: state('OPEN'), text: 'x' }),
    ).toThrow(/human or an agent/)
  })
})

// Turns drafts into what the database would return: seq from 1, one second apart.
function record(drafts: EventDraft[], start = new Date('2026-09-01T00:00:00.000Z')) {
  return drafts.map((draft, index): RecordedEvent => {
    const recordedAt = new Date(start.getTime() + index * 1_000)
    return { ...draft, occurredAt: draft.occurredAt ?? recordedAt, recordedAt, seq: index + 1 }
  })
}

describe('history as of an instant', () => {
  const created = decideCreation({
    actor: analyst,
    deadlineAt,
    deadlineWindowDays: 45,
    now: beforeDeadline,
    reason: null,
  })
  const filed = decideTransition({ now: beforeDeadline, request: evidence(), state: state('OPEN') })
  if (filed.kind !== 'accepted') throw new Error('fixture: evidence should be accepted')
  const noted = decideNote({ actor: analyst, state: state('UNDER_REVIEW'), text: 'waiting' })
  const events = record([...created, filed.event, noted])
  const [first, second, third] = events
  if (!first || !second || !third) throw new Error('fixture: three events expected')

  it('returns the case as it stood at each instant', () => {
    expect(foldHistory(events, first.recordedAt).state).toEqual({ status: 'OPEN', version: 1 })
    expect(foldHistory(events, second.recordedAt).state).toEqual({
      status: 'UNDER_REVIEW',
      version: 2,
    })
  })

  it('says the case did not exist before it was created', () => {
    expect(foldHistory(events, new Date(first.recordedAt.getTime() - 1))).toEqual({
      decidedBy: null,
      events: [],
      state: null,
      truncated: false,
    })
  })

  it('attributes the status to the last deciding event, not to a note', () => {
    const view = foldHistory(events, third.recordedAt)
    expect(view.state).toEqual({ status: 'UNDER_REVIEW', version: 3 })
    expect(view.decidedBy).toEqual({ ruleKey: 'evidence_filed', rulesetVersion: 1, seq: 2 })
    expect(view.events).toHaveLength(3)
  })

  it('reports no deciding rule for a log that holds only notes', () => {
    const notesOnly = record([noted])
    expect(foldHistory(notesOnly, new Date('2030-01-01T00:00:00.000Z')).decidedBy).toBeNull()
  })

  it('folds in seq order whatever order the rows arrive in', () => {
    expect(foldHistory([...events].reverse(), third.recordedAt).state?.version).toBe(3)
  })

  it('shows OPEN between a deadline and the sweep that records it', () => {
    const openOnly = record(created)
    const swept = decideSweep({ now: afterDeadline, state: state('OPEN'), sweepRunId: 'r' })
    if (!swept) throw new Error('fixture: sweep expected')
    const sweptAt = new Date(afterDeadline.getTime() + 60_000)
    const log: RecordedEvent[] = [
      ...openOnly,
      { ...swept, occurredAt: deadlineAt, recordedAt: sweptAt, seq: 2 },
    ]

    expect(foldHistory(log, afterDeadline).state?.status).toBe('OPEN')
    expect(foldHistory(log, sweptAt).state?.status).toBe('LOST')
  })

  it('never re-evaluates rules: a stored decision survives any later rule change', () => {
    // Recorded under an older ruleset that let a late WON stand without evidence. Today's
    // rules would say LOST (deadline_passed). History must report what was decided then.
    const legacy = record([
      ...created,
      {
        actor: analyst,
        from: 'OPEN',
        metadata: { outcome: 'WON', scheme_decided_on: '2026-11-20', scheme_decision_ref: 'X' },
        occurredAt: null,
        reason: null,
        ruleKey: 'scheme_outcome',
        rulesetVersion: 0,
        to: 'WON',
        type: 'SCHEME_OUTCOME_RECORDED',
      },
    ])
    const view = foldHistory(legacy, new Date('2030-01-01T00:00:00.000Z'))

    expect(view.state?.status).toBe('WON')
    expect(view.decidedBy).toEqual({ ruleKey: 'scheme_outcome', rulesetVersion: 0, seq: 2 })
  })

  it('caps very long histories and says so', () => {
    const view = foldHistory(events, third.recordedAt, 2)
    expect(view.truncated).toBe(true)
    expect(view.state).toEqual({ status: 'UNDER_REVIEW', version: 2 })
  })

  it('reconstructs a 400-event case event by event', () => {
    const notes = Array.from({ length: 397 }, (_, i) =>
      decideNote({ actor: analyst, state: state('UNDER_REVIEW'), text: `step ${i}` }),
    )
    const long = record([...created, filed.event, ...notes, ...[noted]])
    const view = foldHistory(long, new Date('2030-01-01T00:00:00.000Z'))

    expect(view.events).toHaveLength(400)
    expect(view.events.map((e) => e.seq)).toEqual(Array.from({ length: 400 }, (_, i) => i + 1))
    expect(view.state).toEqual({ status: 'UNDER_REVIEW', version: 400 })
    expect(view.decidedBy?.seq).toBe(2)
  })
})

describe('invariant 3: the projection agrees with the log', () => {
  const events = record(
    decideCreation({ actor: analyst, deadlineAt, deadlineWindowDays: 45, now, reason: null }),
  )

  it('holds for a consistent projection', () => {
    expect(projectionMatchesLog({ status: 'OPEN', version: 1 }, events)).toBe(true)
  })

  it('holds for a longer log delivered out of order', () => {
    const note = decideNote({ actor: analyst, state: state('OPEN'), text: 'checked' })
    const log = record([
      ...decideCreation({ actor: analyst, deadlineAt, deadlineWindowDays: 45, now, reason: null }),
      note,
      note,
    ]).reverse()
    expect(projectionMatchesLog({ status: 'OPEN', version: 3 }, log)).toBe(true)
  })

  it('fails on a different status, a different version, a gap, or no events', () => {
    expect(projectionMatchesLog({ status: 'LOST', version: 1 }, events)).toBe(false)
    expect(projectionMatchesLog({ status: 'OPEN', version: 2 }, events)).toBe(false)
    const gap = events.map((e) => ({ ...e, seq: e.seq + 1 }))
    expect(projectionMatchesLog({ status: 'OPEN', version: 2 }, gap)).toBe(false)
    expect(projectionMatchesLog({ status: 'OPEN', version: 1 }, [])).toBe(false)
  })
})
