// Events: the closed catalogue of what can happen to a case, the shape of each event, and its
// validation. An event records a decision; it never re-runs one.

export { EVENT_TYPES, MAX_NOTE_BYTES, MAX_REASON_LENGTH } from './constants.js'
export { EventValidationError } from './errors.js'
export type { EventDraft, EventType, MetadataFor, RecordedEvent, TypedMetadata } from './types.js'
export { validateEventDraft } from './validate.js'
