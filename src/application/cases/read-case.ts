import type { HistoryView } from '../../domain/dispute/index.js'
import type { CaseStore } from './ports.js'
import type { CaseRecord, Principal } from './types.js'

import { foldHistory } from '../../domain/dispute/index.js'
import { CaseError } from './errors.js'

export interface CaseHistoryResult {
  asOf: Date
  case: CaseRecord
  view: HistoryView
}

// GET /cases/:id/history?as_of=. The case as its log recorded it at `asOf` (default: now).
// Reconstruction never evaluates rules (D-11); a case of another tenant is not found.
export function caseHistory(
  store: CaseStore,
  principal: Principal,
  caseId: string,
  asOf: Date | null,
): Promise<CaseHistoryResult> {
  return store.transaction(async (tx) => {
    const record = await tx.caseById(principal.tenantId, caseId)
    if (!record) throw new CaseError('case_not_found', 'case not found')
    const at = asOf ?? (await tx.now())
    return { asOf: at, case: record, view: foldHistory(await tx.events(record.id), at) }
  })
}

// GET /cases?external_ref=. Zero or one case: external_ref is unique per tenant.
export function findCaseByExternalRef(
  store: CaseStore,
  principal: Principal,
  externalRef: string,
): Promise<CaseRecord | null> {
  return store.transaction((tx) => tx.caseByExternalRef(principal.tenantId, externalRef))
}

// GET /cases/:id. Another tenant's case is reported as not found, never as forbidden, so its
// existence is not revealed.
export function getCase(
  store: CaseStore,
  principal: Principal,
  caseId: string,
): Promise<CaseRecord> {
  return store.transaction(async (tx) => {
    const record = await tx.caseById(principal.tenantId, caseId)
    if (!record) throw new CaseError('case_not_found', 'case not found')
    return record
  })
}
