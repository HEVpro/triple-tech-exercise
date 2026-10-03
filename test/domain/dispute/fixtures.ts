import type { EventDraft, RecordedEvent } from '../../../src/domain/events/index.js'

import { type CaseState, type TransitionRequest } from '../../../src/domain/dispute/index.js'

// Shared fixtures for the dispute block tests. Fixed instants: the domain never reads a clock.

export const analyst = { id: 'analyst-1', type: 'human' } as const
export const now = new Date('2026-10-03T12:00:00.000Z')
export const today = '2026-10-03'

export const deadlineAt = new Date('2026-10-10T00:00:00.000Z')
export const beforeDeadline = new Date(deadlineAt.getTime() - 1)
export const afterDeadline = new Date(deadlineAt.getTime() + 1)

export function evidence(): TransitionRequest {
  return { actor: analyst, evidenceRefs: ['doc-1'], reason: null, to: 'UNDER_REVIEW' }
}

export function outcome(to: 'LOST' | 'WON'): TransitionRequest {
  return {
    actor: analyst,
    reason: null,
    schemeDecidedOn: '2026-11-20',
    schemeDecisionRef: 'VROL-123',
    to,
  }
}

// Turns drafts into what the database would return: seq from 1, one second apart.
export function record(
  drafts: EventDraft[],
  start = new Date('2026-09-01T00:00:00.000Z'),
): RecordedEvent[] {
  return drafts.map((draft, index): RecordedEvent => {
    const recordedAt = new Date(start.getTime() + index * 1_000)
    return { ...draft, occurredAt: draft.occurredAt ?? recordedAt, recordedAt, seq: index + 1 }
  })
}

export function state(status: CaseState['status']): CaseState {
  return { deadlineAt, deadlineWindowDays: 45, status }
}
