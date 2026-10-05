import { getClient, init } from '@sentry/hono/node'
import { sign } from 'hono/jwt'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { CaseStore } from '../../src/application/cases/index.js'

import { DEV_TENANTS } from '../../scripts/dev-tenants.js'
import { CaseError } from '../../src/application/cases/index.js'
import { createApp } from '../../src/http/app.js'
import { isExpectedError } from '../../src/http/errors.js'
import { trackErrors } from '../../src/monitoring/http.js'
import { AUTH } from '../support/api.js'

// What monitoring reports decides who gets paged (docs/SLOS.md): a failed write must be reported,
// a business rejection must not. The provider runs for real here, keeping the events instead of
// sending them.
const reported: string[] = []

function appFailingWith(error: Error): ReturnType<typeof createApp> {
  return createApp({
    auth: AUTH,
    caseStore: { transaction: () => Promise.reject(error) } as CaseStore,
    instrument: (hono) => {
      trackErrors(hono, (failure) => !isExpectedError(failure))
    },
    ping: () => Promise.resolve(),
  })
}

let authorization: string

beforeAll(async () => {
  init({
    beforeSend: (event) => {
      reported.push(event.exception?.values?.[0]?.value ?? 'unknown')
      return null
    },
    dsn: 'https://public@sentry.invalid/1',
  })
  const now = Math.floor(Date.now() / 1000)
  const token = await sign(
    {
      actor_type: 'human',
      aud: AUTH.audience,
      exp: now + 600,
      iat: now,
      iss: AUTH.issuer,
      sub: 'acme-analyst',
      tenant_id: DEV_TENANTS.acme.id,
    },
    AUTH.secret,
    'HS256',
  )
  authorization = `Bearer ${token}`
})

beforeEach(() => {
  reported.length = 0
})

const CASE_URL = '/cases/00000000-0000-4000-8000-000000000000'

describe('API monitoring', () => {
  it('reports an unexpected failure, which the API answers with a 500', async () => {
    const app = appFailingWith(new Error('connection terminated'))

    const response = await app.request(CASE_URL, { headers: { authorization } })
    await getClient()?.flush(1_000)

    expect(response.status).toBe(500)
    expect(reported).toEqual(['connection terminated'])
  })

  it('does not report a business rejection', async () => {
    const app = appFailingWith(new CaseError('case_not_found', 'case not found'))

    const response = await app.request(CASE_URL, { headers: { authorization } })
    await getClient()?.flush(1_000)

    expect(response.status).toBe(404)
    expect(reported).toEqual([])
  })
})
