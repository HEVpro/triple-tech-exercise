import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

import { z } from '@hono/zod-openapi'

import type { AppEnv } from './context.js'

import { CaseError, type CaseErrorCode } from '../application/cases/index.js'
import { DeadlineError } from '../domain/deadline/index.js'
import { EventValidationError } from '../domain/events/index.js'
import { MoneyError } from '../domain/money/index.js'
import { logger } from '../logger.js'

// Every error the API returns has this shape, whatever produced it. `code` is the stable,
// machine-readable part of the contract; `message` is for humans and may change.
export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: 'rule_conflict' }),
      details: z.unknown().optional(),
      message: z.string(),
    }),
  })
  .openapi('Error')

export type ErrorCode =
  | 'internal_error'
  | 'route_not_found'
  | 'service_unavailable'
  | 'unauthenticated'
  | 'validation_failed'
  | CaseErrorCode

const CASE_ERROR_STATUS: Readonly<Record<CaseErrorCode, ContentfulStatusCode>> = {
  case_closed: 409,
  case_not_found: 404,
  external_ref_conflict: 409,
  not_an_action: 422,
  presentment_in_future: 422,
  response_window_missing: 422,
  rule_conflict: 409,
  tenant_not_found: 403,
  unsupported_currency: 422,
}

export interface ErrorBody {
  error: { code: ErrorCode; details?: unknown; message: string }
}

export function errorBody(code: ErrorCode, message: string, details?: unknown): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, details, message } }
}

// app.onError: business rejections keep their code; domain validation that slipped past the
// request schemas is a 400; anything else is logged and hidden behind a 500.
export function handleError(error: Error, c: Context<AppEnv>): Response {
  if (error instanceof CaseError) {
    const details = error.decided
      ? { decided_by: { rule_key: error.decided.ruleKey, status: error.decided.status } }
      : undefined
    return c.json(errorBody(error.code, error.message, details), CASE_ERROR_STATUS[error.code])
  }
  if (isDomainValidationError(error)) {
    return c.json(errorBody('validation_failed', error.message), 400)
  }
  logger().error({ err: error, requestId: c.get('requestId') }, 'unhandled error')
  return c.json(errorBody('internal_error', 'internal error'), 500)
}

// An error the API answers with a 4xx on purpose: a business rejection or invalid input. Anything
// else is a defect or an outage: a 500, and the only kind monitoring reports as a failure.
export function isExpectedError(error: unknown): boolean {
  return error instanceof CaseError || isDomainValidationError(error)
}

// The default hook of every route: a request that fails its Zod schema gets the same envelope
// as any other error, with one entry per issue.
export function validationHook(
  result: { error: z.ZodError; success: false } | { success: true },
  c: Context<AppEnv>,
): Response | undefined {
  if (result.success) return undefined
  const details = result.error.issues.map((issue) => ({
    message: issue.message,
    path: issue.path.join('.'),
  }))
  return c.json(errorBody('validation_failed', 'the request is not valid', details), 400)
}

function isDomainValidationError(error: unknown): boolean {
  return (
    error instanceof EventValidationError ||
    error instanceof DeadlineError ||
    error instanceof MoneyError
  )
}
