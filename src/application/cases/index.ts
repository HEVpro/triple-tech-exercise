// Case use cases: each runs in one transaction, reads the database clock, asks the domain to
// decide, and writes the projection and its events together. Storage is reached through the
// CaseStore port only.

export { addNote, type AddNoteResult } from './add-note.js'
export { createCase, type CreateCaseInput, type CreateCaseResult } from './create-case.js'
export { CaseError, type CaseErrorCode } from './errors.js'
export type { CaseStore, CaseTransaction } from './ports.js'
export { caseHistory, type CaseHistoryResult, findCaseByExternalRef, getCase } from './read-case.js'
export { sweepDeadlines, type SweepOptions, type SweepResult } from './sweep-deadlines.js'
export { transitionCase, type TransitionInput, type TransitionResult } from './transition-case.js'
export type {
  CaseRecord,
  FxRateRecord,
  NewCaseRecord,
  Principal,
  ResponseWindowRecord,
  Scheme,
  TenantRecord,
} from './types.js'
