import { z } from 'zod'

// The case resource as published in v1, frozen. Banks integrate against this shape.
//
// It is deliberately written by hand rather than imported from src/http: if it were derived from
// the code, renaming a field in the code would rename it here too and the test would pass while
// every integrated bank broke. z.object is not strict, so a response with *more* fields still
// satisfies it: adding a field is compatible, removing or renaming one, or changing its type,
// is not. Never edit an existing entry; a breaking change needs a new version of the resource.
export const CASE_V1 = z.object({
  amount_base_minor: z.int(),
  amount_cents: z.int(),
  amount_minor: z.int(),
  base_currency: z.string().length(3),
  created_at: z.iso.datetime(),
  currency: z.string().length(3),
  currency_exponent: z.int(),
  deadline_at: z.iso.datetime(),
  deadline_tz: z.string(),
  deadline_window_days: z.int(),
  decided_by_rule: z.string(),
  external_ref: z.string(),
  fx_rate: z.string(),
  fx_rate_date: z.iso.date(),
  id: z.uuid(),
  presentment_date: z.iso.date(),
  reason_code: z.string(),
  scheme: z.enum(['VISA', 'MASTERCARD', 'OTHER']),
  status: z.enum(['OPEN', 'UNDER_REVIEW', 'WON', 'LOST']),
  updated_at: z.iso.datetime(),
  version: z.int(),
})

export function satisfiesCaseV1(body: unknown): true {
  const result = CASE_V1.safeParse(body)
  if (!result.success) {
    throw new Error(`response breaks the v1 case contract:\n${z.prettifyError(result.error)}`)
  }
  return true
}
