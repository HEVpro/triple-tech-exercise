import { z } from 'zod'

import type { EventDraft } from './types.js'

import { MAX_REASON_LENGTH } from './constants.js'
import { EventValidationError } from './errors.js'
import { metadataSchema } from './schemas.js'

// Checks a draft before it is written: metadata shape, reason length, and that only the
// system expires a deadline (the database enforces the last two as well).
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
