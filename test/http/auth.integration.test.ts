import { sign } from 'hono/jwt'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DEV_TENANTS } from '../../scripts/dev-tenants.js'
import { AUTH, startApi, type TestApi } from '../support/api.js'
import { databaseAvailable } from '../support/temp-database.js'

const available = await databaseAvailable()
let api: TestApi
let acmeCaseId: string

beforeAll(async () => {
  if (!available) return
  api = await startApi()
  const { body } = await api.request('POST', '/cases', {
    body: {
      amount_cents: 9_900,
      currency: 'EUR',
      external_ref: 'ACME-ONLY',
      presentment_date: new Date().toISOString().slice(0, 10),
      reason_code: '10.4',
      scheme: 'VISA',
    },
  })
  acmeCaseId = String(body['id'])
})

afterAll(async () => {
  if (available) await api.drop()
})

describe.skipIf(!available)('authentication', () => {
  it.each([
    ['no token', null],
    ['a malformed token', 'not.a.jwt'],
  ])('rejects a request with %s', async (_label, token) => {
    const { body, status } = await api.request('GET', `/cases/${acmeCaseId}`, { token })

    expect(status).toBe(401)
    expect(body).toMatchObject({ error: { code: 'unauthenticated' } })
  })

  it('rejects a token signed with another secret', async () => {
    const forged = await sign(
      {
        actor_type: 'human',
        aud: AUTH.audience,
        exp: 9_999_999_999,
        iss: AUTH.issuer,
        sub: 'x',
        tenant_id: DEV_TENANTS.acme.id,
      },
      'another-secret-that-is-long-enough-0123456789',
      'HS256',
    )
    expect((await api.request('GET', `/cases/${acmeCaseId}`, { token: forged })).status).toBe(401)
  })

  it.each([
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 60 }],
    ['a token for another audience', { aud: 'someone-else' }],
    ['a token from another issuer', { iss: 'someone-else' }],
    ['a token without exp, which would never expire', { exp: undefined }],
    ['a token without tenant_id', { tenant_id: undefined }],
    ['a token claiming to be the system', { actor_type: 'system' }],
  ])('rejects %s', async (_label, claims) => {
    const token = await api.token('acme', claims)
    expect((await api.request('GET', `/cases/${acmeCaseId}`, { token })).status).toBe(401)
  })

  it('records an agent token as an agent', async () => {
    const token = await api.token('acme', { actor_type: 'agent', sub: 'triage-bot' })
    const { body } = await api.request('POST', `/cases/${acmeCaseId}/notes`, {
      body: { text: 'auto-triaged' },
      token,
    })

    expect(body).toMatchObject({ event: { actor: { id: 'triage-bot', type: 'agent' } } })
  })
})

describe.skipIf(!available)('tenant isolation', () => {
  it("answers 404, not 403, for another tenant's case on every case route", async () => {
    const globex = await api.token('globex')

    const responses = await Promise.all([
      api.request('GET', `/cases/${acmeCaseId}`, { token: globex }),
      api.request('GET', `/cases/${acmeCaseId}/history`, { token: globex }),
      api.request('POST', `/cases/${acmeCaseId}/notes`, { body: { text: 'x' }, token: globex }),
      api.request('POST', `/cases/${acmeCaseId}/transitions`, {
        body: { evidence_refs: ['D'], reason: 'r', to: 'UNDER_REVIEW' },
        token: globex,
      }),
    ])

    expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404])
  })

  it("does not find another tenant's case by external_ref", async () => {
    const globex = await api.token('globex')
    const { body } = await api.request('GET', '/cases?external_ref=ACME-ONLY', { token: globex })

    expect(body).toEqual({ items: [] })
  })

  it('ignores any attempt to choose the tenant from the request', async () => {
    const globex = await api.token('globex')
    const attempt = await api.request(
      'GET',
      `/cases/${acmeCaseId}?tenant_id=${DEV_TENANTS.acme.id}`,
      { headers: { 'x-tenant-id': DEV_TENANTS.acme.id }, token: globex },
    )

    expect(attempt.status).toBe(404)
  })

  it('lets two tenants use the same external_ref independently', async () => {
    const globex = await api.token('globex')
    const { status } = await api.request('POST', '/cases', {
      body: {
        amount_cents: 1_000,
        currency: 'USD',
        external_ref: 'ACME-ONLY',
        presentment_date: new Date().toISOString().slice(0, 10),
        reason_code: '10.4',
        scheme: 'VISA',
      },
      token: globex,
    })

    expect(status).toBe(201)
  })
})

describe.skipIf(!available)('the API runs with the restricted role', () => {
  it('cannot rewrite history even through its own connection', async () => {
    // The API's pool is triple_api. The owner checks what that role is allowed to do.
    const { rows } = await api.owner.query<{ can_update: boolean; can_delete: boolean }>(`
      SELECT has_table_privilege('triple_api', 'case_events', 'UPDATE') AS can_update,
             has_table_privilege('triple_api', 'cases', 'DELETE') AS can_delete`)

    expect(rows[0]).toEqual({ can_delete: false, can_update: false })
  })
})

describe('auth suite without a database', () => {
  it('skips itself when postgres is unreachable', () => {
    expect(typeof available).toBe('boolean')
  })
})
