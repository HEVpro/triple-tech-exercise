// The closed catalogue of case events (docs/DOMAIN.md, "Event catalogue"). The database
// enforces the same list with a CHECK constraint.
export const EVENT_TYPES = [
  'CASE_CREATED',
  'EVIDENCE_FILED',
  'SCHEME_OUTCOME_RECORDED',
  'DEADLINE_EXPIRED',
  'NOTE_ADDED',
] as const

export const MAX_NOTE_BYTES = 2_048
export const MAX_REASON_LENGTH = 1_000
