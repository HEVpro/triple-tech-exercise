export const CASE_STATUSES = ['OPEN', 'UNDER_REVIEW', 'WON', 'LOST'] as const

export type CaseStatus = (typeof CASE_STATUSES)[number]

export type TerminalStatus = Extract<CaseStatus, 'LOST' | 'WON'>

// WON and LOST are absorbing: once a case reaches either, nothing moves it again.
export function isTerminal(status: CaseStatus): status is TerminalStatus {
  return status === 'WON' || status === 'LOST'
}
