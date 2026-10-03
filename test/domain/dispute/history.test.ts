import { describe, expect, it } from 'vitest'

import type { RecordedEvent } from '../../../src/domain/events/index.js'

import {
  decideCreation,
  decideNote,
  decideSweep,
  decideTransition,
  foldHistory,
  projectionMatchesLog,
} from '../../../src/domain/dispute/index.js'
import {
  afterDeadline,
  analyst,
  beforeDeadline,
  deadlineAt,
  evidence,
  now,
  record,
  state,
} from './fixtures.js'

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
