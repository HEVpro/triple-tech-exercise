import { z } from '@hono/zod-openapi'

import { QUEUE_STATES } from '../../domain/dispute/index.js'
import { CaseSchema } from '../cases/schemas.js'

const STATE_LIST = new RegExp(`^(${QUEUE_STATES.join('|')})(,(${QUEUE_STATES.join('|')}))*$`)

export const StuckQueueQuery = z.object({
  cursor: z
    .string()
    .optional()
    .openapi({
      description: 'next_cursor of the previous page',
      param: { in: 'query', name: 'cursor' },
    }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .openapi({ param: { in: 'query', name: 'limit' } }),
  risk_window_days: z.coerce
    .number()
    .int()
    .min(1)
    .max(90)
    .default(7)
    .openapi({ param: { in: 'query', name: 'risk_window_days' } }),
  // Comma-separated. By default the actionable states; `responded` (evidence filed, waiting for
  // the card network) is counted in the summary and listed only when asked for.
  state: z
    .string()
    .regex(STATE_LIST, `a comma-separated list of: ${QUEUE_STATES.join(', ')}`)
    .default('at_risk,breached')
    .openapi({ example: 'at_risk,breached', param: { in: 'query', name: 'state' } }),
})

const totals = z.object({ amount_base_minor: z.int(), count: z.int() })

export const StuckQueueSchema = z
  .object({
    base_currency: z.string(),
    generated_at: z.iso.datetime(),
    items: z.array(
      CaseSchema.extend({
        deadline_state: z.enum(QUEUE_STATES),
        // Negative once the deadline has passed.
        seconds_to_deadline: z.int(),
      }),
    ),
    next_cursor: z.string().nullable(),
    risk_window_days: z.int(),
    states: z.array(z.enum(QUEUE_STATES)),
    summary: z.object({ at_risk: totals, breached: totals, responded: totals }),
  })
  .openapi('StuckQueue')
