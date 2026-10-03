import type { Decision } from '../../domain/rules/index.js'

export type CaseErrorCode =
  | 'case_closed'
  | 'case_not_found'
  | 'external_ref_conflict'
  | 'not_an_action'
  | 'presentment_in_future'
  | 'response_window_missing'
  | 'rule_conflict'
  | 'tenant_not_found'
  | 'unsupported_currency'

// A business rejection the client can act on. The HTTP layer maps each code to a status; the
// message is safe to return as it is.
export class CaseError extends Error {
  override name = 'CaseError'

  constructor(
    readonly code: CaseErrorCode,
    message: string,
    readonly decided?: Decision,
  ) {
    super(message)
  }
}
