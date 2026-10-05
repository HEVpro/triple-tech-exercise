import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { satisfiesHistoryV1 } from '../contract/history-v1.js'
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

async function openCase(): Promise<string> {
  const { body } = await api.request('POST', '/cases', {
    body: {
      amount_cents: 7_700,
      currency: 'EUR',
      external_ref: `BANK-${crypto.randomUUID()}`,
      presentment_date: new Date().toISOString().slice(0, 10),
      reason_code: '10.4',
      scheme: 'VISA',
    },
  })
  return String(body['id'])
}

const evidence = { evidence_refs: ['DOC-1'], reason: 'proof of delivery', to: 'UNDER_REVIEW' }

interface HistoryBody {
  decided_by: { rule_key: string; seq: number } | null
  events: { recorded_at: string; seq: number; type: string }[]
  state: null | Record<string, unknown>
}

describe.skipIf(!available)('GET /cases/:id/history', () => {
  it('returns the current state and every event, with who and when', async () => {
    const id = await openCase()
    await api.request('POST', `/cases/${id}/transitions`, { body: evidence })

    const { body, status } = await api.request('GET', `/cases/${id}/history`)
    const history = body as unknown as HistoryBody

    expect(status).toBe(200)
    expect(satisfiesHistoryV1(body)).toBe(true)
    expect(history.state).toMatchObject({ status: 'UNDER_REVIEW', version: 2 })
    expect(history.decided_by).toMatchObject({ rule_key: 'evidence_filed', seq: 2 })
    expect(history.events.map((e) => [e.seq, e.type])).toEqual([
      [1, 'CASE_CREATED'],
      [2, 'EVIDENCE_FILED'],
    ])
  })

  it('reconstructs the case as it was recorded at an earlier instant', async () => {
    const id = await openCase()
    await api.request('POST', `/cases/${id}/transitions`, { body: evidence })
    const full = (await api.request('GET', `/cases/${id}/history`)).body as unknown as HistoryBody
    const createdAt = full.events[0]?.recorded_at ?? ''

    const { body } = await api.request(
      'GET',
      `/cases/${id}/history?as_of=${encodeURIComponent(createdAt)}`,
    )
    const past = body as unknown as HistoryBody

    expect(past.state).toMatchObject({ status: 'OPEN', version: 1 })
    expect(past.events).toHaveLength(1)
  })

  it('says the case did not exist yet, rather than failing, before it was created', async () => {
    const id = await openCase()

    const { body, status } = await api.request(
      'GET',
      `/cases/${id}/history?as_of=2000-01-01T00:00:00Z`,
    )

    expect(status).toBe(200)
    expect(body).toMatchObject({ decided_by: null, events: [], state: null })
    expect(satisfiesHistoryV1(body)).toBe(true)
  })

  it('can read in a read-only snapshot, as multi-query reads do', async () => {
    // History (and the stuck-queue report) run in a `snapshot` transaction: REPEATABLE READ and
    // read only, so their several queries see one state. A write inside one must fail, which
    // proves the option reaches PostgreSQL.
    const id = await openCase()
    const tenantId = '11111111-1111-4111-8111-111111111111'

    await expect(
      api.store.transaction(
        async (tx) => {
          const record = await tx.caseById(tenantId, id)
          if (!record) throw new Error('fixture: case expected')
          return tx.advance(record, 'OPEN', 'default_open')
        },
        { snapshot: true },
      ),
    ).rejects.toMatchObject({
      // Drizzle wraps the driver error; PostgreSQL's own reason is the cause.
      cause: { message: expect.stringMatching(/read-only transaction/) as unknown },
    })
  })

  it('rejects an as_of without a time zone', async () => {
    const id = await openCase()

    const { status } = await api.request('GET', `/cases/${id}/history?as_of=2026-01-01T00:00:00`)

    expect(status).toBe(400)
  })

  it('review scenario 3: a case with 400 events is reconstructed event by event', async () => {
    const id = await openCase()
    await api.request('POST', `/cases/${id}/transitions`, { body: evidence })
    for (let index = 0; index < 398; index++) {
      await api.request('POST', `/cases/${id}/notes`, { body: { text: `step ${String(index)}` } })
    }

    const started = performance.now()
    const { body } = await api.request('GET', `/cases/${id}/history`)
    const elapsed = performance.now() - started
    const history = body as unknown as HistoryBody

    expect(history.events.map((e) => e.seq)).toEqual(Array.from({ length: 400 }, (_, i) => i + 1))
    expect(history.state).toMatchObject({ status: 'UNDER_REVIEW', version: 400 })
    expect(history.decided_by).toMatchObject({ rule_key: 'evidence_filed', seq: 2 })
    // Indicative only: the measured figure belongs to phase 5. It must be far inside 200 ms.
    expect(elapsed).toBeLessThan(200)
  }, 30_000)
})

describe('history suite without a database', () => {
  it('skips itself when postgres is unreachable', () => {
    expect(typeof available).toBe('boolean')
  })
})
