import { z } from 'zod'

import { MAX_NOTE_BYTES } from './constants.js'

// The shape of each event's metadata. Every schema is bounded (a 2 KB note, at most 50
// references of 100 characters), so valid metadata always stays well under the database's
// 16 KB cap. This is the only place in the domain that uses Zod.

const reference = z.string().trim().min(1).max(100)

export const metadataSchema = z.discriminatedUnion('type', [
  z.strictObject({
    metadata: z.strictObject({ source: z.literal('api') }),
    type: z.literal('CASE_CREATED'),
  }),
  z.strictObject({
    metadata: z.strictObject({ evidence_refs: z.array(reference).min(1).max(50) }),
    type: z.literal('EVIDENCE_FILED'),
  }),
  z.strictObject({
    metadata: z.strictObject({
      outcome: z.enum(['WON', 'LOST']),
      scheme_decided_on: z.iso.date(),
      scheme_decision_ref: reference,
    }),
    type: z.literal('SCHEME_OUTCOME_RECORDED'),
  }),
  z.strictObject({
    metadata: z.strictObject({
      deadline_at: z.iso.datetime(),
      detected_by: z.enum(['creation', 'sweeper']),
      sweep_run_id: reference.optional(),
      window_days: z.int().min(1).max(365),
    }),
    type: z.literal('DEADLINE_EXPIRED'),
  }),
  z.strictObject({
    metadata: z.strictObject({
      text: z
        .string()
        .trim()
        .min(1)
        .refine((text) => byteLength(text) <= MAX_NOTE_BYTES, {
          message: `a note is at most ${MAX_NOTE_BYTES} bytes`,
        }),
    }),
    type: z.literal('NOTE_ADDED'),
  }),
])

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}
