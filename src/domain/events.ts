import { z } from 'zod'

import type { RuleKey } from './rules.js'
import type { CaseStatus } from './status.js'

// The closed catalogue of case events (docs/DOMAIN.md, "Event catalogue"). The database
// enforces the same list with a CHECK constraint; this module enforces the shape of each
// event's metadata. Every schema is bounded (a 2 KB note, at most 50 references of 100
// characters), so valid metadata always stays well under the database's 16 KB cap.

export const EVENT_TYPES = [
  'CASE_CREATED',
  'EVIDENCE_FILED',
  'SCHEME_OUTCOME_RECORDED',
  'DEADLINE_EXPIRED',
  'NOTE_ADDED',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export const ACTOR_TYPES = ['human', 'agent', 'system'] as const

export interface Actor {
  id: string
  type: ActorType
}

export type ActorType = (typeof ACTOR_TYPES)[number]

export const SYSTEM_SWEEPER: Actor = { id: 'deadline-sweeper', type: 'system' }

export const MAX_NOTE_BYTES = 2_048
export const MAX_REASON_LENGTH = 1_000

const reference = z.string().trim().min(1).max(100)

const metadataSchema = z.discriminatedUnion('type', [
  z.strictObject({
    metadata: z.strictObject({ source: z.literal('api') }),
    type: z.literal('CASE_CREATED'),
  }),
  z.strictObject({
    metadata: z.strictObject({ evidence_refs: z.array(reference).min(1).max(50) }),
    type: z.literal('EVIDENCE_FILED'),
  }),
  z.strictObject({
    metadata: z.strictObject({
      outcome: z.enum(['WON', 'LOST']),
      scheme_decided_on: z.iso.date(),
      scheme_decision_ref: reference,
    }),
    type: z.literal('SCHEME_OUTCOME_RECORDED'),
  }),
  z.strictObject({
    metadata: z.strictObject({
      deadline_at: z.iso.datetime(),
      detected_by: z.enum(['creation', 'sweeper']),
      sweep_run_id: reference.optional(),
      window_days: z.int().min(1).max(365),
    }),
    type: z.literal('DEADLINE_EXPIRED'),
  }),
  z.strictObject({
    metadata: z.strictObject({
      text: z
        .string()
        .trim()
        .min(1)
        .refine((text) => byteLength(text) <= MAX_NOTE_BYTES, {
          message: `a note is at most ${MAX_NOTE_BYTES} bytes`,
        }),
    }),
    type: z.literal('NOTE_ADDED'),
  }),
])

// What the domain decides. The database adds seq and recorded_at; occurred_at is only set
// here for DEADLINE_EXPIRED, whose business time is the deadline itself.
export type EventDraft = {
  [T in EventType]: {
    actor: Actor
    from: CaseStatus | null
    metadata: MetadataFor<T>
    occurredAt: Date | null
    reason: null | string
    // Mirrors case_events_rule_presence_check: a note decides nothing, every other event
    // names the rule and ruleset that decided it.
    ruleKey: T extends 'NOTE_ADDED' ? null : RuleKey
    rulesetVersion: T extends 'NOTE_ADDED' ? null : number
    to: CaseStatus
    type: T
  }
}[EventType]

export type MetadataFor<T extends EventType> = Extract<TypedMetadata, { type: T }>['metadata']

// An event as stored: the draft plus what the database stamped on it.
export type RecordedEvent = EventDraft & {
  occurredAt: Date
  recordedAt: Date
  seq: number
}

export type TypedMetadata = z.infer<typeof metadataSchema>

export class EventValidationError extends Error {
  override name = 'EventValidationError'
}

export function validateEventDraft(draft: EventDraft): EventDraft {
  const parsed = metadataSchema.safeParse({ metadata: draft.metadata, type: draft.type })
  if (!parsed.success) {
    throw new EventValidationError(`${draft.type}: ${z.prettifyError(parsed.error)}`)
  }
  if (draft.reason !== null && draft.reason.length > MAX_REASON_LENGTH) {
    throw new EventValidationError(`${draft.type}: reason exceeds ${MAX_REASON_LENGTH} characters`)
  }
  if ((draft.actor.type === 'system') !== (draft.type === 'DEADLINE_EXPIRED')) {
    throw new EventValidationError(`${draft.type}: only the system expires a deadline`)
  }
  return { ...draft, metadata: parsed.data.metadata } as EventDraft
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}
