import { z } from 'zod'

import { CASE_V1 } from './case-v1.js'

// The stuck-queue report as published in v1, frozen and written by hand for the same reason as
// CASE_V1: adding a field is compatible, removing, renaming or retyping one is not.
const totals = z.object({ amount_base_minor: z.int(), count: z.int() })
const state = z.enum(['at_risk', 'breached', 'responded'])

export const STUCK_QUEUE_V1 = z.object({
  base_currency: z.string().length(3),
  generated_at: z.iso.datetime(),
  items: z.array(CASE_V1.extend({ deadline_state: state, seconds_to_deadline: z.int() })),
  next_cursor: z.string().nullable(),
  risk_window_days: z.int(),
  states: z.array(state),
  summary: z.object({ at_risk: totals, breached: totals, responded: totals }),
})

export function satisfiesStuckQueueV1(body: unknown): true {
  const result = STUCK_QUEUE_V1.safeParse(body)
  if (!result.success) {
    throw new Error(
      `response breaks the v1 stuck-queue contract:\n${z.prettifyError(result.error)}`,
    )
  }
  return true
}
