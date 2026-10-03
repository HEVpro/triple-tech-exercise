import type { EventDraft } from '../../domain/events/index.js'
import type { CaseStore } from './ports.js'
import type { CaseRecord, Principal } from './types.js'

import { decideNote } from '../../domain/dispute/index.js'
import { CaseError } from './errors.js'

export interface AddNoteResult {
  case: CaseRecord
  event: EventDraft
}

// POST /cases/:id/notes. Records work on a case; the status and deciding rule do not change,
// but the version does, because every event takes the next sequence number.
export function addNote(
  store: CaseStore,
  principal: Principal,
  caseId: string,
  text: string,
): Promise<AddNoteResult> {
  return store.transaction(async (tx) => {
    const record = await tx.caseById(principal.tenantId, caseId, { forUpdate: true })
    if (!record) throw new CaseError('case_not_found', 'case not found')

    const event = decideNote({
      actor: principal.actor,
      state: {
        deadlineAt: record.deadline_at,
        deadlineWindowDays: record.deadline_window_days,
        status: record.status,
      },
      text,
    })
    const advanced = await tx.advance(record, record.status, record.decided_by_rule)
    await tx.appendEvents(advanced, [{ draft: event, seq: advanced.version }])
    return { case: advanced, event }
  })
}
