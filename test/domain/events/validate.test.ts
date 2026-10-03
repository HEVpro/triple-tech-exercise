import { describe, expect, it } from 'vitest'

import {
  type EventDraft,
  EventValidationError,
  MAX_NOTE_BYTES,
  validateEventDraft,
} from '../../../src/domain/events/index.js'

const analyst = { id: 'analyst-1', type: 'human' } as const

function evidence(refs: string[]): EventDraft {
  return {
    actor: analyst,
    from: 'OPEN',
    metadata: { evidence_refs: refs },
    occurredAt: null,
    reason: 'proof of delivery',
    ruleKey: 'evidence_filed',
    rulesetVersion: 1,
    to: 'UNDER_REVIEW',
    type: 'EVIDENCE_FILED',
  }
}

function note(text: string): EventDraft {
  return {
    actor: analyst,
    from: 'OPEN',
    metadata: { text },
    occurredAt: null,
    reason: null,
    ruleKey: null,
    rulesetVersion: null,
    to: 'OPEN',
    type: 'NOTE_ADDED',
  }
}

describe('event metadata', () => {
  it('accepts a well-formed event and trims references', () => {
    const validated = validateEventDraft(evidence(['  doc-1 ']))
    expect(validated.metadata).toEqual({ evidence_refs: ['doc-1'] })
  })

  it('rejects keys the event type does not define', () => {
    const draft = { ...evidence(['doc-1']), metadata: { evidence_refs: ['doc-1'], pan: '4111' } }
    expect(() => validateEventDraft(draft as EventDraft)).toThrow(EventValidationError)
  })

  it('requires at least one evidence reference', () => {
    expect(() => validateEventDraft(evidence([]))).toThrow(EventValidationError)
  })

  it('caps a note in bytes, not characters', () => {
    expect(() => validateEventDraft(note('a'.repeat(MAX_NOTE_BYTES)))).not.toThrow()
    // 'é' is two bytes in UTF-8: well under the limit in characters, over it in bytes.
    expect(() => validateEventDraft(note('é'.repeat(MAX_NOTE_BYTES / 2 + 1)))).toThrow(
      /at most 2048 bytes/,
    )
    expect(() => validateEventDraft(note('   '))).toThrow(EventValidationError)
  })

  it('caps the free-text reason', () => {
    const draft = { ...evidence(['doc-1']), reason: 'x'.repeat(1_001) }
    expect(() => validateEventDraft(draft)).toThrow(/reason exceeds/)
  })

  it('reserves the system actor for the deadline expiry, and the expiry for the system', () => {
    expect(() =>
      validateEventDraft({ ...note('hi'), actor: { id: 'sweeper', type: 'system' } }),
    ).toThrow(/only the system expires a deadline/)

    expect(() =>
      validateEventDraft({
        actor: analyst,
        from: 'OPEN',
        metadata: {
          deadline_at: '2026-02-16T00:00:00.000Z',
          detected_by: 'sweeper',
          window_days: 45,
        },
        occurredAt: new Date('2026-02-16T00:00:00.000Z'),
        reason: null,
        ruleKey: 'deadline_passed',
        rulesetVersion: 1,
        to: 'LOST',
        type: 'DEADLINE_EXPIRED',
      }),
    ).toThrow(/only the system expires a deadline/)
  })
})
