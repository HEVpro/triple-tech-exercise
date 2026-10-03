import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { satisfiesCaseV1 } from '../contract/case-v1.js'
import { startApi, type TestApi } from '../support/api.js'
import { databaseAvailable } from '../support/temp-database.js'

const available = await databaseAvailable()
let api: TestApi

beforeAll(async () => {
  if (available) api = await startApi()
})

afterAll(async () => {
  if (available) await api.drop()
})

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
}

function newCase(overrides: Record<string, unknown> = {}) {
  return {
    amount_cents: 12_500,
    currency: 'EUR',
    external_ref: `BANK-${crypto.randomUUID()}`,
    presentment_date: daysAgo(10),
    reason_code: '10.4',
    scheme: 'VISA',
    ...overrides,
  }
}

describe.skipIf(!available)('POST /cases', () => {
  it('creates an OPEN case with its deadline and money fields', async () => {
    const { body, status } = await api.request('POST', '/cases', { body: newCase() })

    expect(status).toBe(201)
    expect(satisfiesCaseV1(body)).toBe(true)
    expect(body).toMatchObject({
      amount_base_minor: 12_500,
      amount_cents: 12_500,
      amount_minor: 12_500,
      base_currency: 'EUR',
      currency_exponent: 2,
      deadline_tz: 'UTC',
      deadline_window_days: 45,
      decided_by_rule: 'default_open',
      status: 'OPEN',
      version: 1,
    })
  })

  it('review scenario 1: Visa presented 40 days ago is open with about five days left', async () => {
    const { body } = await api.request('POST', '/cases', {
      body: newCase({ presentment_date: daysAgo(40), scheme: 'VISA' }),
    })

    const daysLeft = (Date.parse(body['deadline_at'] as string) - Date.now()) / 86_400_000
    expect(body['status']).toBe('OPEN')
    expect(daysLeft).toBeGreaterThan(5)
    expect(daysLeft).toBeLessThan(6)
  })

  it('review scenario 2: Mastercard presented 50 days ago is lost the moment it is created', async () => {
    const created = await api.request('POST', '/cases', {
      body: newCase({ presentment_date: daysAgo(50), scheme: 'MASTERCARD' }),
    })

    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      decided_by_rule: 'deadline_passed',
      status: 'LOST',
      version: 2,
    })

    const history = await api.request('GET', `/cases/${String(created.body['id'])}/history`)
    const events = history.body['events'] as Record<string, unknown>[]
    expect(events.map((e) => [e['type'], e['to'], e['actor']])).toEqual([
      ['CASE_CREATED', 'OPEN', { id: 'acme-analyst', type: 'human' }],
      ['DEADLINE_EXPIRED', 'LOST', { id: 'deadline-sweeper', type: 'system' }],
    ])
    expect(events[1]?.['occurred_at']).toBe(created.body['deadline_at'])
  })

  it('is idempotent on external_ref: the same payload returns the same case', async () => {
    const payload = newCase()
    const first = await api.request('POST', '/cases', { body: payload })
    const again = await api.request('POST', '/cases', { body: payload })

    expect(again.status).toBe(200)
    expect(again.body['id']).toBe(first.body['id'])
  })

  it('rejects the same external_ref with different values', async () => {
    const payload = newCase()
    await api.request('POST', '/cases', { body: payload })
    const conflicting = await api.request('POST', '/cases', {
      body: { ...payload, amount_cents: 1 },
    })

    expect(conflicting.status).toBe(409)
    expect(conflicting.body).toMatchObject({ error: { code: 'external_ref_conflict' } })
  })

  it('creates exactly one case when the same request arrives twice at once', async () => {
    const payload = newCase()
    const responses = await Promise.all([
      api.request('POST', '/cases', { body: payload }),
      api.request('POST', '/cases', { body: payload }),
    ])

    expect(responses.map((r) => r.status).sort()).toEqual([200, 201])
    expect(new Set(responses.map((r) => r.body['id'])).size).toBe(1)
  })

  it('scales by the currency exponent: JPY has no minor unit', async () => {
    const { body } = await api.request('POST', '/cases', {
      body: newCase({ amount_cents: 100_000, currency: 'JPY' }),
    })

    expect(body).toMatchObject({
      amount_base_minor: 62_000,
      amount_cents: 100_000,
      currency_exponent: 0,
      fx_rate: '0.0062000000',
    })
  })

  it("converts to the tenant's own base currency: Globex reports in USD", async () => {
    const token = await api.token('globex')
    const { body } = await api.request('POST', '/cases', {
      body: newCase({ amount_cents: 10_000, currency: 'EUR' }),
      token,
    })

    expect(body).toMatchObject({ amount_base_minor: 10_870, base_currency: 'USD' })
  })

  it.each([
    ['an unknown scheme', { scheme: 'AMEX' }, 400, 'validation_failed'],
    ['a negative amount', { amount_cents: -5 }, 400, 'validation_failed'],
    ['a fractional amount', { amount_cents: 10.5 }, 400, 'validation_failed'],
    ['a malformed currency', { currency: 'euro' }, 400, 'validation_failed'],
    ['an impossible date', { presentment_date: '2026-02-30' }, 400, 'validation_failed'],
    ['an unsupported currency', { currency: 'XXX' }, 422, 'unsupported_currency'],
    [
      'a presentment in the future',
      { presentment_date: daysAgo(-3) },
      422,
      'presentment_in_future',
    ],
  ])('rejects %s', async (_label, overrides, status, code) => {
    const response = await api.request('POST', '/cases', { body: newCase(overrides) })

    expect(response.status).toBe(status)
    expect(response.body).toMatchObject({ error: { code } })
  })

  it('lists every validation issue with its path', async () => {
    const response = await api.request('POST', '/cases', { body: { scheme: 'VISA' } })

    const details = (response.body['error'] as { details: { path: string }[] }).details
    expect(details.map((d) => d.path)).toEqual(
      expect.arrayContaining(['amount_cents', 'currency', 'external_ref', 'presentment_date']),
    )
  })
})

describe.skipIf(!available)('GET /cases/:id and GET /cases?external_ref=', () => {
  it('fetches a case by id and by external_ref', async () => {
    const created = await api.request('POST', '/cases', { body: newCase() })
    const id = String(created.body['id'])
    const ref = String(created.body['external_ref'])

    const byId = await api.request('GET', `/cases/${id}`)
    const byRef = await api.request('GET', `/cases?external_ref=${encodeURIComponent(ref)}`)

    expect(byId.status).toBe(200)
    expect(satisfiesCaseV1(byId.body)).toBe(true)
    expect(byRef.body).toEqual({ items: [byId.body] })
  })

  it('returns an empty list, not an error, for an unknown external_ref', async () => {
    const { body, status } = await api.request('GET', '/cases?external_ref=NOPE')

    expect(status).toBe(200)
    expect(body).toEqual({ items: [] })
  })

  it('answers 404 for an unknown id and 400 for a malformed one', async () => {
    const missing = await api.request('GET', `/cases/${crypto.randomUUID()}`)
    const malformed = await api.request('GET', '/cases/not-a-uuid')

    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ error: { code: 'case_not_found' } })
    expect(malformed.status).toBe(400)
  })
})

describe('create-case suite without a database', () => {
  it('skips itself when postgres is unreachable', () => {
    expect(typeof available).toBe('boolean')
  })
})
