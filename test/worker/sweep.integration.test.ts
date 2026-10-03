import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { sweepDeadlines } from '../../src/application/cases/index.js'
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

const options = { batchSize: 500, maxBatches: 10, sweepRunId: 'run-test' }

// The deadline of a freshly created case is weeks away; the owner moves it into the past, as the
// passing of time would. The API itself cannot do this.
async function expireDeadline(ids: string[], minutesAgo = 5): Promise<void> {
  await api.owner.query(
    `UPDATE cases SET deadline_at = now() - make_interval(mins => $2) WHERE id = ANY($1::uuid[])`,
    [ids, minutesAgo],
  )
}

async function expiryEvents(id: string) {
  const { rows } = await api.owner.query<{
    actor_id: string
    actor_type: string
    deadline_at: Date
    metadata: Record<string, unknown>
    occurred_at: Date
    recorded_at: Date
    seq: number
  }>(
    `SELECT e.seq, e.actor_type, e.actor_id, e.occurred_at, e.recorded_at, e.metadata, c.deadline_at
     FROM case_events e JOIN cases c ON c.id = e.case_id
     WHERE e.case_id = $1 AND e.event_type = 'DEADLINE_EXPIRED'`,
    [id],
  )
  return rows
}

async function openCase(tenant: 'acme' | 'globex' = 'acme'): Promise<string> {
  const { body } = await api.request('POST', '/cases', {
    body: {
      amount_cents: 4_200,
      currency: tenant === 'acme' ? 'EUR' : 'USD',
      external_ref: `BANK-${crypto.randomUUID()}`,
      presentment_date: new Date().toISOString().slice(0, 10),
      reason_code: '10.4',
      scheme: 'VISA',
    },
    token: await api.token(tenant),
  })
  return String(body['id'])
}

describe.skipIf(!available)('sweeping expired deadlines', () => {
  it('records the loss for an OPEN case past its deadline, dated at the deadline', async () => {
    const id = await openCase()
    await expireDeadline([id])

    const result = await sweepDeadlines(api.store, options)

    expect(result.expired).toBeGreaterThanOrEqual(1)
    expect(result.maxLagSeconds).toBeGreaterThanOrEqual(300)
    const { body } = await api.request('GET', `/cases/${id}`)
    expect(body).toMatchObject({ decided_by_rule: 'deadline_passed', status: 'LOST', version: 2 })

    const [event] = await expiryEvents(id)
    expect(event).toMatchObject({
      actor_id: 'deadline-sweeper',
      actor_type: 'system',
      metadata: { detected_by: 'sweeper', sweep_run_id: 'run-test' },
      seq: 2,
    })
    expect(event?.occurred_at).toEqual(event?.deadline_at)
    expect(event?.recorded_at.getTime()).toBeGreaterThan(event?.occurred_at.getTime() ?? 0)
  })

  it('leaves alone a case that answered in time and one still in time', async () => {
    const answered = await openCase()
    await api.request('POST', `/cases/${answered}/transitions`, {
      body: { evidence_refs: ['DOC-1'], reason: 'proof', to: 'UNDER_REVIEW' },
    })
    await expireDeadline([answered])
    const inTime = await openCase()

    await sweepDeadlines(api.store, options)

    expect((await api.request('GET', `/cases/${answered}`)).body['status']).toBe('UNDER_REVIEW')
    expect((await api.request('GET', `/cases/${inTime}`)).body['status']).toBe('OPEN')
  })

  it('is idempotent: a second sweep records nothing new', async () => {
    const id = await openCase()
    await expireDeadline([id])
    await sweepDeadlines(api.store, options)

    const again = await sweepDeadlines(api.store, options)

    expect(again.expired).toBe(0)
    expect(await expiryEvents(id)).toHaveLength(1)
  })

  it('works through a backlog in batches, across tenants', async () => {
    const ids = [
      ...(await Promise.all([1, 2, 3].map(() => openCase('acme')))),
      ...(await Promise.all([1, 2].map(() => openCase('globex')))),
    ]
    await expireDeadline(ids)

    const result = await sweepDeadlines(api.store, { ...options, batchSize: 2 })

    expect(result.expired).toBe(5)
    expect(result.batches).toBe(3)
  })

  it('never records a case twice when two sweepers run at once', async () => {
    const ids = await Promise.all(Array.from({ length: 12 }, () => openCase()))
    await expireDeadline(ids)

    const [first, second] = await Promise.all([
      sweepDeadlines(api.store, { ...options, batchSize: 3, sweepRunId: 'run-a' }),
      sweepDeadlines(api.store, { ...options, batchSize: 3, sweepRunId: 'run-b' }),
    ])

    expect(first.expired + second.expired).toBe(12)
    for (const id of ids) expect(await expiryEvents(id)).toHaveLength(1)
  })
})

describe('sweep suite without a database', () => {
  it('skips itself when postgres is unreachable', () => {
    expect(typeof available).toBe('boolean')
  })
})
