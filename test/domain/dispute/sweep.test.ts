import { describe, expect, it } from 'vitest'

import { decideSweep } from '../../../src/domain/dispute/index.js'
import { afterDeadline, beforeDeadline, deadlineAt, state } from './fixtures.js'

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
