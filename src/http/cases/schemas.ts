import { z } from '@hono/zod-openapi'
import { createSchemaFactory } from 'drizzle-zod'

import { cases } from '../../infrastructure/db/schema/index.js'

// Request and response schemas for /cases. Each one drives request validation, the handler's
// types and the OpenAPI document, so the contract cannot drift from the code.
//
// Column-backed fields come from the Drizzle table via drizzle-zod, refined with the same limits
// the database CHECK constraints enforce, so the API rejects what the database would.

const { createInsertSchema } = createSchemaFactory({ zodInstance: z })

const SCHEMES = ['VISA', 'MASTERCARD', 'OTHER'] as const
const STATUSES = ['OPEN', 'UNDER_REVIEW', 'WON', 'LOST'] as const

// 10^15 minor units: far beyond any dispute, and still exact as a JSON number after conversion
// to any base currency in fx_rates.
export const MAX_AMOUNT_MINOR = 1_000_000_000_000_000

const caseColumns = createInsertSchema(cases, {
  currency: (schema) => schema.regex(/^[A-Z]{3}$/, 'an ISO 4217 code such as EUR'),
  external_ref: (schema) => schema.min(1).max(128),
  presentment_date: () => z.iso.date(),
  reason_code: (schema) => schema.min(1).max(20),
  scheme: () => z.enum(SCHEMES),
})

const reason = z.string().trim().min(1).max(1000)
const reference = z.string().trim().min(1).max(100)

export const CaseIdParams = z.object({
  id: z.uuid().openapi({ param: { in: 'path', name: 'id' } }),
})

export const CreateCaseBody = caseColumns
  .pick({
    currency: true,
    external_ref: true,
    presentment_date: true,
    reason_code: true,
    scheme: true,
  })
  .extend({
    // The brief's field name. Integer minor units of `currency` (its ISO 4217 exponent decides
    // how many: 0 for JPY, 2 for EUR, 3 for KWD), so it is not always cents (D-4).
    amount_cents: z.int().positive().max(MAX_AMOUNT_MINOR),
    reason: reason.optional(),
  })
  .openapi('CreateCase')

export const FindCasesQuery = z.object({
  external_ref: z
    .string()
    .min(1)
    .max(128)
    .openapi({ param: { in: 'query', name: 'external_ref' } }),
})

export const TransitionBody = z
  .discriminatedUnion('to', [
    z.object({
      evidence_refs: z.array(reference).min(1).max(50),
      reason,
      to: z.literal('UNDER_REVIEW'),
    }),
    z.object({
      reason,
      scheme_decided_on: z.iso.date(),
      scheme_decision_ref: reference,
      to: z.enum(['WON', 'LOST']),
    }),
    z.object({ reason, to: z.literal('OPEN') }),
  ])
  .openapi('Transition')

export const NoteBody = z.object({ text: z.string().trim().min(1) }).openapi('Note')

export const HistoryQuery = z.object({
  as_of: z.iso
    .datetime({ offset: true })
    .optional()
    .openapi({ example: '2026-10-01T00:00:00Z', param: { in: 'query', name: 'as_of' } }),
})

export const CaseSchema = z
  .object({
    amount_base_minor: z.int(),
    // Same value as amount_minor, under the brief's name. Kept for integrated banks; deprecated.
    amount_cents: z.int().openapi({ deprecated: true }),
    amount_minor: z.int(),
    base_currency: z.string(),
    created_at: z.iso.datetime(),
    currency: z.string(),
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
    scheme: z.enum(SCHEMES),
    status: z.enum(STATUSES),
    updated_at: z.iso.datetime(),
    version: z.int(),
  })
  .openapi('Case')

export const EventSchema = z
  .object({
    actor: z.object({ id: z.string(), type: z.enum(['human', 'agent', 'system']) }),
    from: z.enum(STATUSES).nullable(),
    metadata: z.record(z.string(), z.unknown()),
    occurred_at: z.iso.datetime(),
    reason: z.string().nullable(),
    recorded_at: z.iso.datetime(),
    rule_key: z.string().nullable(),
    ruleset_version: z.int().nullable(),
    seq: z.int(),
    to: z.enum(STATUSES),
    type: z.string(),
  })
  .openapi('CaseEvent')

export const CaseListSchema = z.object({ items: z.array(CaseSchema) }).openapi('CaseList')

export const CaseWithEventSchema = z
  .object({ case: CaseSchema, event: EventSchema.nullable() })
  .openapi('CaseWithEvent')

export const HistorySchema = z
  .object({
    as_of: z.iso.datetime(),
    case_id: z.uuid(),
    decided_by: z
      .object({ rule_key: z.string(), ruleset_version: z.int(), seq: z.int() })
      .nullable(),
    events: z.array(EventSchema),
    // The case as recorded at as_of; null when it did not exist yet.
    state: CaseSchema.nullable(),
    truncated: z.boolean(),
  })
  .openapi('CaseHistory')
