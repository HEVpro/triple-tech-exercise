import { createRoute, OpenAPIHono } from '@hono/zod-openapi'

import type { CaseStore } from '../../application/cases/index.js'
import type { AppEnv } from '../context.js'

import {
  addNote,
  caseHistory,
  createCase,
  findCaseByExternalRef,
  getCase,
  transitionCase,
} from '../../application/cases/index.js'
import { ErrorResponseSchema, validationHook } from '../errors.js'
import { toCaseJson, toHistoryJson, toNewEventJson } from './presenter.js'
import {
  CaseIdParams,
  CaseListSchema,
  CaseSchema,
  CaseWithEventSchema,
  CreateCaseBody,
  FindCasesQuery,
  HistoryQuery,
  HistorySchema,
  NoteBody,
  TransitionBody,
} from './schemas.js'

const json = <T>(schema: T) => ({ 'application/json': { schema } })

const ERROR_DESCRIPTIONS = {
  400: 'validation_failed: the request does not match the schema',
  401: 'unauthenticated: missing, invalid or expired bearer token',
  403: 'tenant_not_found: the tenant in the token does not exist',
  404: "case_not_found: no such case for this tenant (another tenant's case is also 404)",
  409: 'rule_conflict, case_closed or external_ref_conflict',
  422: 'not_an_action, unsupported_currency, presentment_in_future or response_window_missing',
} as const

function errorResponse(description: string) {
  return { content: json(ErrorResponseSchema), description }
}

function errors<S extends keyof typeof ERROR_DESCRIPTIONS>(
  ...statuses: S[]
): Record<S, ReturnType<typeof errorResponse>> {
  const responses = {} as Record<S, ReturnType<typeof errorResponse>>
  for (const status of statuses) responses[status] = errorResponse(ERROR_DESCRIPTIONS[status])
  return responses
}

const common = { security: [{ bearerAuth: [] }], tags: ['cases'] }

const createCaseRoute = createRoute({
  ...common,
  method: 'post',
  operationId: 'createCase',
  path: '/cases',
  request: { body: { content: json(CreateCaseBody), required: true } },
  responses: {
    200: { content: json(CaseSchema), description: 'The case already existed with these values' },
    201: { content: json(CaseSchema), description: 'Created' },
    ...errors(400, 401, 403, 409, 422),
  },
  summary: 'Create a case, idempotent on external_ref',
})

const getCaseRoute = createRoute({
  ...common,
  method: 'get',
  operationId: 'getCase',
  path: '/cases/{id}',
  request: { params: CaseIdParams },
  responses: {
    200: { content: json(CaseSchema), description: 'The case' },
    ...errors(400, 401, 404),
  },
  summary: 'Fetch a case',
})

const findCasesRoute = createRoute({
  ...common,
  method: 'get',
  operationId: 'findCases',
  path: '/cases',
  request: { query: FindCasesQuery },
  responses: {
    200: { content: json(CaseListSchema), description: 'Zero or one case' },
    ...errors(400, 401),
  },
  summary: "Find a case by the bank's own reference",
})

const transitionRoute = createRoute({
  ...common,
  method: 'post',
  operationId: 'transitionCase',
  path: '/cases/{id}/transitions',
  request: {
    body: { content: json(TransitionBody), required: true },
    params: CaseIdParams,
  },
  responses: {
    200: {
      content: json(CaseWithEventSchema),
      description: 'Already in that status; nothing written',
    },
    201: { content: json(CaseWithEventSchema), description: 'Transition recorded' },
    ...errors(400, 401, 404, 409, 422),
  },
  summary: 'Request a status; the terminal rules decide',
})

const noteRoute = createRoute({
  ...common,
  method: 'post',
  operationId: 'addNote',
  path: '/cases/{id}/notes',
  request: { body: { content: json(NoteBody), required: true }, params: CaseIdParams },
  responses: {
    201: { content: json(CaseWithEventSchema), description: 'Note recorded' },
    ...errors(400, 401, 404),
  },
  summary: 'Record work on a case without changing its status',
})

const historyRoute = createRoute({
  ...common,
  method: 'get',
  operationId: 'caseHistory',
  path: '/cases/{id}/history',
  request: { params: CaseIdParams, query: HistoryQuery },
  responses: {
    200: { content: json(HistorySchema), description: 'The case as recorded at as_of' },
    ...errors(400, 401, 404),
  },
  summary: 'Reconstruct a case from its event log, as of an instant',
})

export function caseRoutes(store: CaseStore): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: validationHook })

  routes.openapi(createCaseRoute, async (c) => {
    const body = c.req.valid('json')
    const result = await createCase(store, c.get('principal'), {
      amount_minor: BigInt(body.amount_cents),
      currency: body.currency,
      external_ref: body.external_ref,
      presentment_date: body.presentment_date,
      reason: body.reason ?? null,
      reason_code: body.reason_code,
      scheme: body.scheme,
    })
    return c.json(toCaseJson(result.case), result.created ? 201 : 200)
  })

  routes.openapi(getCaseRoute, async (c) => {
    const record = await getCase(store, c.get('principal'), c.req.valid('param').id)
    return c.json(toCaseJson(record), 200)
  })

  routes.openapi(findCasesRoute, async (c) => {
    const { external_ref } = c.req.valid('query')
    const record = await findCaseByExternalRef(store, c.get('principal'), external_ref)
    return c.json({ items: record ? [toCaseJson(record)] : [] }, 200)
  })

  routes.openapi(transitionRoute, async (c) => {
    const result = await transitionCase(
      store,
      c.get('principal'),
      c.req.valid('param').id,
      c.req.valid('json'),
    )
    const body = {
      case: toCaseJson(result.case),
      event: result.event ? toNewEventJson(result.case, result.event) : null,
    }
    return c.json(body, result.event ? 201 : 200)
  })

  routes.openapi(noteRoute, async (c) => {
    const result = await addNote(
      store,
      c.get('principal'),
      c.req.valid('param').id,
      c.req.valid('json').text,
    )
    return c.json(
      { case: toCaseJson(result.case), event: toNewEventJson(result.case, result.event) },
      201,
    )
  })

  routes.openapi(historyRoute, async (c) => {
    const { as_of } = c.req.valid('query')
    const result = await caseHistory(
      store,
      c.get('principal'),
      c.req.valid('param').id,
      as_of === undefined ? null : new Date(as_of),
    )
    return c.json(toHistoryJson(result.case, result.view, result.asOf), 200)
  })

  return routes
}
