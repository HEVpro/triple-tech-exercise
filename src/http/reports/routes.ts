import { createRoute, OpenAPIHono } from '@hono/zod-openapi'

import type { CaseStore } from '../../application/cases/index.js'
import type { QueueState } from '../../domain/dispute/index.js'
import type { AppEnv } from '../context.js'

import { stuckQueue } from '../../application/cases/index.js'
import { toCaseJson } from '../cases/presenter.js'
import { errorBody, ErrorResponseSchema, validationHook } from '../errors.js'
import { decodeCursor, encodeCursor } from './cursor.js'
import { StuckQueueQuery, StuckQueueSchema } from './schemas.js'

const errorResponse = (description: string) => ({
  content: { 'application/json': { schema: ErrorResponseSchema } },
  description,
})

const stuckQueueRoute = createRoute({
  method: 'get',
  operationId: 'stuckQueue',
  path: '/reports/stuck-queue',
  request: { query: StuckQueueQuery },
  responses: {
    200: {
      content: { 'application/json': { schema: StuckQueueSchema } },
      description: 'Summary of all states and one page of the requested ones, by amount',
    },
    400: errorResponse('validation_failed, including an invalid cursor'),
    401: errorResponse('unauthenticated'),
    403: errorResponse('tenant_not_found'),
  },
  security: [{ bearerAuth: [] }],
  summary: 'Where the bank is losing money: at-risk, breached and responded cases',
  tags: ['reports'],
})

export function reportRoutes(store: CaseStore): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: validationHook })

  routes.openapi(stuckQueueRoute, async (c) => {
    const query = c.req.valid('query')
    const after = query.cursor === undefined ? null : decodeCursor(query.cursor)
    if (after === undefined) {
      return c.json(
        errorBody('validation_failed', 'the request is not valid', [
          { message: 'not a cursor returned by this endpoint', path: 'cursor' },
        ]),
        400,
      )
    }

    const states = [...new Set(query.state.split(','))] as QueueState[]
    const result = await stuckQueue(store, c.get('principal'), {
      after,
      limit: query.limit,
      riskWindowDays: query.risk_window_days,
      states,
    })

    const totals = (state: QueueState) => ({
      amount_base_minor: Number(result.summary[state].amount_base_minor),
      count: result.summary[state].count,
    })
    return c.json(
      {
        base_currency: result.baseCurrency,
        generated_at: result.generatedAt.toISOString(),
        items: result.items.map((item) => ({
          ...toCaseJson(item.case),
          deadline_state: item.deadlineState,
          seconds_to_deadline: item.secondsToDeadline,
        })),
        next_cursor: encodeCursor(result.next),
        risk_window_days: query.risk_window_days,
        states,
        summary: {
          at_risk: totals('at_risk'),
          breached: totals('breached'),
          responded: totals('responded'),
        },
      },
      200,
    )
  })

  return routes
}
