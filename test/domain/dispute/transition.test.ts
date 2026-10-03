import { describe, expect, it } from 'vitest'

import { decideTransition } from '../../../src/domain/dispute/index.js'
import {
  afterDeadline,
  analyst,
  beforeDeadline,
  deadlineAt,
  evidence,
  now,
  outcome,
  state,
} from './fixtures.js'

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
    expect(
      decideTransition({
        now,
        request: { actor: analyst, reason: null, to: 'OPEN' },
        state: state('OPEN'),
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
