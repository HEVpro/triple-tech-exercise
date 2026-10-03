import type { RuleKey } from '../rules/index.js'
import type { CaseStatus } from '../shared/index.js'

import { isWithinDeadline } from '../deadline/index.js'

// Where a case stands in the stuck-queue report (docs/DOMAIN.md, "Stuck-queue report").
//
//   at_risk    OPEN and the deadline is still ahead: the bank can act, and must.
//   breached   the deadline passed without an answer: LOST by the deadline rule, or OPEN and about
//              to be recorded as such by the next sweep. Money already lost.
//   responded  UNDER_REVIEW: evidence was filed in time; the card network has not decided yet.
//
// null means the case is not part of the queue at all (won, or lost to the network's decision).
export const QUEUE_STATES = ['at_risk', 'breached', 'responded'] as const

export type QueueState = (typeof QUEUE_STATES)[number]

export function queueState(
  record: { decidedByRule: RuleKey; deadlineAt: Date; status: CaseStatus },
  now: Date,
): null | QueueState {
  switch (record.status) {
    case 'LOST':
      return record.decidedByRule === 'deadline_passed' ? 'breached' : null
    case 'OPEN':
      return isWithinDeadline(now, record.deadlineAt) ? 'at_risk' : 'breached'
    case 'UNDER_REVIEW':
      return 'responded'
    case 'WON':
      return null
  }
}
