import { z } from 'zod'

import { CASE_V1 } from './case-v1.js'

// A case's history as published in v1, frozen and written by hand for the same reason as
// CASE_V1: adding a field is compatible, removing, renaming or retyping one is not. This is the
// audit trail a regulator or a bank reads, so its shape is a promise.
const status = z.enum(['OPEN', 'UNDER_REVIEW', 'WON', 'LOST'])

const EVENT_V1 = z.object({
  actor: z.object({ id: z.string(), type: z.enum(['human', 'agent', 'system']) }),
  from: status.nullable(),
  metadata: z.record(z.string(), z.unknown()),
  occurred_at: z.iso.datetime(),
  reason: z.string().nullable(),
  recorded_at: z.iso.datetime(),
  rule_key: z.string().nullable(),
  ruleset_version: z.int().nullable(),
  seq: z.int(),
  to: status,
  type: z.string(),
})

export const HISTORY_V1 = z.object({
  as_of: z.iso.datetime(),
  case_id: z.uuid(),
  decided_by: z.object({ rule_key: z.string(), ruleset_version: z.int(), seq: z.int() }).nullable(),
  events: z.array(EVENT_V1),
  state: CASE_V1.nullable(),
  truncated: z.boolean(),
})

export function satisfiesHistoryV1(body: unknown): true {
  const result = HISTORY_V1.safeParse(body)
  if (!result.success) {
    throw new Error(`response breaks the v1 history contract:\n${z.prettifyError(result.error)}`)
  }
  return true
}
