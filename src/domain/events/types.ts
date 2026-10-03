import type { z } from 'zod'

import type { RuleKey } from '../rules/index.js'
import type { Actor, CaseStatus } from '../shared/index.js'
import type { EVENT_TYPES } from './constants.js'
import type { metadataSchema } from './schemas.js'

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

export type EventType = (typeof EVENT_TYPES)[number]

export type MetadataFor<T extends EventType> = Extract<TypedMetadata, { type: T }>['metadata']

// An event as stored: the draft plus what the database stamped on it.
export type RecordedEvent = EventDraft & {
  occurredAt: Date
  recordedAt: Date
  seq: number
}

export type TypedMetadata = z.infer<typeof metadataSchema>
