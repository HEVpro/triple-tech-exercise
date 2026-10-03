import type { CaseFacts } from '../rules/index.js'
import type { CaseState } from './types.js'

// Facts follow from the status, because the status was itself decided from the facts:
// UNDER_REVIEW can only be reached by filing evidence in time, and terminal states never
// reach this function.
export function factsFor(state: CaseState): CaseFacts {
  return {
    deadlineAt: state.deadlineAt,
    evidenceFiledInTime: state.status === 'UNDER_REVIEW',
    outcome: null,
  }
}
