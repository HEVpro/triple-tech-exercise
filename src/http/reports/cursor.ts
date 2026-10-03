import { z } from 'zod'

import type { StuckQueueResult } from '../../application/cases/index.js'

// The page cursor is opaque to clients: base64url of the last row's (amount_base_minor, id). It
// carries no tenant and grants nothing; the query is always scoped to the token's tenant.
const cursorSchema = z.object({ a: z.string().regex(/^\d+$/), i: z.uuid() })

type After = StuckQueueResult['next']

export function decodeCursor(cursor: string): After | undefined {
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    )
    return parsed.success
      ? { amount_base_minor: BigInt(parsed.data.a), id: parsed.data.i }
      : undefined
  } catch {
    return undefined
  }
}

export function encodeCursor(after: After): null | string {
  if (!after) return null
  return Buffer.from(
    JSON.stringify({ a: after.amount_base_minor.toString(), i: after.id }),
  ).toString('base64url')
}
