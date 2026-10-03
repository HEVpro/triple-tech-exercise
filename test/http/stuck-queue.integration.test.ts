import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { satisfiesStuckQueueV1 } from '../contract/stuck-queue-v1.js'
import { startApi, type TestApi } from '../support/api.js'
import { databaseAvailable } from '../support/temp-database.js'

// One API (and database) per file: every test looks only at the cases it created itself, so the
// tests do not depend on each other or on their order.
const available = await databaseAvailable()
let api: TestApi

beforeAll(async () => {
  if (available) api = await startApi()
})

afterAll(async () => {
  if (available) await api.drop()
})

interface Queue {
  items: {
    deadline_state: string
    id: string
    seconds_to_deadline: number
    amount_base_minor: number
  }[]
  next_cursor: null | string
  summary: Record<string, { amount_base_minor: number; count: number }>
}

async function createCase(fields: Record<string, unknown>, tenant: 'acme' | 'globex' = 'acme') {
  const { body, status } = await api.request('POST', '/cases', {
    body: {
      amount_cents: 10_000,
      currency: 'EUR',
      external_ref: `BANK-${crypto.randomUUID()}`,
      presentment_date: daysAgo(40),
      reason_code: '10.4',
      scheme: 'VISA',
      ...fields,
    },
    token: await api.token(tenant),
  })
  expect(status).toBe(201)
  return String(body['id'])
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
}

async function queue(query = '', tenant: 'acme' | 'globex' = 'acme') {
  const response = await api.request('GET', `/reports/stuck-queue${query}`, {
    token: await api.token(tenant),
  })
  return { ...response, queue: response.body as unknown as Queue }
}

describe.skipIf(!available)('GET /reports/stuck-queue', () => {
  it('review scenarios 1 and 2: at-risk and breached, ordered by money, with a summary', async () => {
    const empty = (await queue()).queue.summary
    const atRisk = await createCase({ amount_cents: 30_000, scheme: 'VISA' })
    const breached = await createCase({
      amount_cents: 50_000,
      presentment_date: daysAgo(50),
      scheme: 'MASTERCARD',
    })
    const later = await createCase({ amount_cents: 99_000, presentment_date: daysAgo(1) })

    const { body, queue: report, status } = await queue('?limit=200')
    const mine = report.items.filter((i) => [atRisk, breached, later].includes(i.id))

    expect(status).toBe(200)
    expect(satisfiesStuckQueueV1(body)).toBe(true)
    expect(mine.map((i) => [i.id, i.deadline_state])).toEqual([
      [breached, 'breached'],
      [atRisk, 'at_risk'],
    ])
    expect(mine[0]?.seconds_to_deadline).toBeLessThan(0)
    expect(mine[1]?.seconds_to_deadline).toBeGreaterThan(5 * 86_400)
    // The summary grew by exactly what this test created.
    expect(report.summary['at_risk']).toEqual({
      amount_base_minor: (empty['at_risk']?.amount_base_minor ?? 0) + 30_000,
      count: (empty['at_risk']?.count ?? 0) + 1,
    })
    expect(report.summary['breached']).toEqual({
      amount_base_minor: (empty['breached']?.amount_base_minor ?? 0) + 50_000,
      count: (empty['breached']?.count ?? 0) + 1,
    })
  })

  it('counts responded cases always, and lists them only when asked', async () => {
    const id = await createCase({ amount_cents: 70_000, presentment_date: daysAgo(2) })
    await api.request('POST', `/cases/${id}/transitions`, {
      body: { evidence_refs: ['DOC-1'], reason: 'proof', to: 'UNDER_REVIEW' },
    })

    const byDefault = await queue('?risk_window_days=90')
    const asked = await queue('?state=responded&risk_window_days=90')

    expect(byDefault.queue.items.map((i) => i.id)).not.toContain(id)
    expect(byDefault.queue.summary['responded']?.count).toBeGreaterThanOrEqual(1)
    expect(asked.queue.items.map((i) => [i.id, i.deadline_state])).toContainEqual([id, 'responded'])
  })

  it('shows an OPEN case past its deadline as breached before the sweeper records it', async () => {
    const id = await createCase({ amount_cents: 1_234 })
    await api.owner.query(
      `UPDATE cases SET deadline_at = now() - interval '1 hour' WHERE id = $1`,
      [id],
    )

    const { queue: report } = await queue('?state=breached')

    expect(report.items.find((i) => i.id === id)).toMatchObject({ deadline_state: 'breached' })
  })

  it('orders by money in the base currency, not by raw minor units', async () => {
    // ¥30 000 is 30 000 minor units but worth €186; €200.00 is 20 000 minor units.
    const yen = await createCase({
      amount_cents: 30_000,
      currency: 'JPY',
      presentment_date: daysAgo(39),
    })
    const euro = await createCase({ amount_cents: 20_000, presentment_date: daysAgo(39) })

    const { queue: report } = await queue('?state=at_risk&limit=200')
    const order = report.items.map((i) => i.id)

    expect(order.indexOf(euro)).toBeLessThan(order.indexOf(yen))
  })

  it('pages through every row exactly once, in order, with an opaque cursor', async () => {
    await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        createCase({ amount_cents: 5_000 + (i % 3), presentment_date: daysAgo(41) }),
      ),
    )
    const all = (await queue('?state=at_risk&limit=200')).queue.items

    const seen: Queue['items'] = []
    let cursor: null | string = ''
    while (cursor !== null) {
      const { queue: page } = await queue(
        `?state=at_risk&limit=3${cursor ? `&cursor=${cursor}` : ''}`,
      )
      seen.push(...page.items)
      cursor = page.next_cursor
    }

    expect(seen.map((i) => i.id)).toEqual(all.map((i) => i.id))
    expect(new Set(seen.map((i) => i.id)).size).toBe(seen.length)
  })

  it("never shows another tenant's cases", async () => {
    const globexCase = await createCase({ amount_cents: 999_999, currency: 'USD' }, 'globex')

    const acme = await queue('?state=at_risk,breached,responded&limit=200')
    const globex = await queue('', 'globex')

    expect(acme.queue.items.map((i) => i.id)).not.toContain(globexCase)
    expect(globex.queue.items.map((i) => i.id)).toContain(globexCase)
    expect(globex.body['base_currency']).toBe('USD')
  })

  it.each([
    ['an unknown state', '?state=lost'],
    ['a limit of zero', '?limit=0'],
    ['a risk window too large', '?risk_window_days=365'],
    ['a forged cursor', '?cursor=bm90LWEtY3Vyc29y'],
  ])('rejects %s', async (_label, query) => {
    const { body, status } = await queue(query)

    expect(status).toBe(400)
    expect(body).toMatchObject({ error: { code: 'validation_failed' } })
  })

  it('requires a token', async () => {
    const { status } = await api.request('GET', '/reports/stuck-queue', { token: null })
    expect(status).toBe(401)
  })
})

describe('stuck-queue suite without a database', () => {
  it('skips itself when postgres is unreachable', () => {
    expect(typeof available).toBe('boolean')
  })
})
