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

async function openCase(presentedDaysAgo = 10): Promise<string> {
  const { body } = await api.request('POST', '/cases', {
    body: {
      amount_cents: 5_000,
      currency: 'EUR',
      external_ref: `BANK-${crypto.randomUUID()}`,
      presentment_date: daysAgo(presentedDaysAgo),
      reason_code: '13.1',
      scheme: 'VISA',
    },
  })
  return String(body['id'])
}

const evidence = { evidence_refs: ['DOC-1'], reason: 'proof of delivery', to: 'UNDER_REVIEW' }
const won = {
  reason: 'scheme ruled for the issuer',
  scheme_decided_on: daysAgo(0),
  scheme_decision_ref: 'VROL-42',
  to: 'WON',
}

describe.skipIf(!available)('POST /cases/:id/transitions', () => {
  it('files evidence before the deadline and records who did it', async () => {
    const id = await openCase()

    const { body, status } = await api.request('POST', `/cases/${id}/transitions`, {
      body: evidence,
    })

    expect(status).toBe(201)
    expect(satisfiesCaseV1(body['case'])).toBe(true)
    expect(body).toMatchObject({
      case: { decided_by_rule: 'evidence_filed', status: 'UNDER_REVIEW', version: 2 },
      event: {
        actor: { id: 'acme-analyst', type: 'human' },
        from: 'OPEN',
        metadata: { evidence_refs: ['DOC-1'] },
        reason: 'proof of delivery',
        rule_key: 'evidence_filed',
        seq: 2,
        to: 'UNDER_REVIEW',
        type: 'EVIDENCE_FILED',
      },
    })
  })

  it('records the scheme outcome after evidence, and then the case is closed', async () => {
    const id = await openCase()
    await api.request('POST', `/cases/${id}/transitions`, { body: evidence })

    const outcome = await api.request('POST', `/cases/${id}/transitions`, { body: won })
    const after = await api.request('POST', `/cases/${id}/transitions`, {
      body: { ...won, to: 'LOST' },
    })

    expect(outcome.status).toBe(201)
    expect(outcome.body).toMatchObject({ case: { status: 'WON', version: 3 } })
    expect(after.status).toBe(409)
    expect(after.body).toMatchObject({ error: { code: 'case_closed' } })
  })

  it('treats a repeated request as a no-op, so a retry writes nothing', async () => {
    const id = await openCase()
    await api.request('POST', `/cases/${id}/transitions`, { body: evidence })

    const retry = await api.request('POST', `/cases/${id}/transitions`, { body: evidence })

    expect(retry.status).toBe(200)
    expect(retry.body).toMatchObject({ case: { version: 2 }, event: null })
  })

  it('refuses evidence once the deadline has passed, naming the rule that decided', async () => {
    // An OPEN case whose deadline passes before the sweeper records it. The API cannot produce
    // this directly (a case born late is LOST at once), so the owner moves the deadline back.
    const id = await openCase()
    await api.owner.query(
      `UPDATE cases SET deadline_at = now() - interval '1 hour' WHERE id = $1`,
      [id],
    )

    const { body, status } = await api.request('POST', `/cases/${id}/transitions`, {
      body: evidence,
    })

    expect(status).toBe(409)
    expect(body).toMatchObject({
      error: {
        code: 'rule_conflict',
        details: { decided_by: { rule_key: 'deadline_passed', status: 'LOST' } },
      },
    })
    const unchanged = await api.request('GET', `/cases/${id}`)
    expect(unchanged.body).toMatchObject({ status: 'OPEN', version: 1 })
  })

  it('refuses any transition on a case that was born lost', async () => {
    const id = await openCase(60)

    const { body, status } = await api.request('POST', `/cases/${id}/transitions`, {
      body: evidence,
    })

    expect(status).toBe(409)
    expect(body).toMatchObject({ error: { code: 'case_closed' } })
  })

  it('rejects OPEN as a target and a transition without a reason', async () => {
    const id = await openCase()

    const toOpen = await api.request('POST', `/cases/${id}/transitions`, {
      body: { reason: 'reopen', to: 'OPEN' },
    })
    const noReason = await api.request('POST', `/cases/${id}/transitions`, {
      body: { evidence_refs: ['DOC-1'], to: 'UNDER_REVIEW' },
    })

    expect(toOpen.status).toBe(422)
    expect(toOpen.body).toMatchObject({ error: { code: 'not_an_action' } })
    expect(noReason.status).toBe(400)
  })

  it('serialises concurrent transitions on one case: one wins, the other is a no-op', async () => {
    const id = await openCase()

    const responses = await Promise.all([
      api.request('POST', `/cases/${id}/transitions`, { body: evidence }),
      api.request('POST', `/cases/${id}/transitions`, { body: evidence }),
    ])

    expect(responses.map((r) => r.status).sort()).toEqual([200, 201])
    const events = await api.owner.query('SELECT seq FROM case_events WHERE case_id = $1', [id])
    expect(events.rows.map((row: { seq: number }) => row.seq)).toEqual([1, 2])
  })
})

describe.skipIf(!available)('POST /cases/:id/notes', () => {
  it('records work without changing the status, and takes the next sequence number', async () => {
    const id = await openCase()

    const { body, status } = await api.request('POST', `/cases/${id}/notes`, {
      body: { text: 'requested proof of delivery from the merchant' },
    })

    expect(status).toBe(201)
    expect(body).toMatchObject({
      case: { decided_by_rule: 'default_open', status: 'OPEN', version: 2 },
      event: { from: 'OPEN', rule_key: null, seq: 2, to: 'OPEN', type: 'NOTE_ADDED' },
    })
  })

  it('rejects an empty note and one longer than 2 KB', async () => {
    const id = await openCase()

    const empty = await api.request('POST', `/cases/${id}/notes`, { body: { text: '   ' } })
    const long = await api.request('POST', `/cases/${id}/notes`, {
      body: { text: 'é'.repeat(1_100) },
    })

    expect(empty.status).toBe(400)
    expect(long.status).toBe(400)
  })
})

describe('transitions suite without a database', () => {
  it('skips itself when postgres is unreachable', () => {
    expect(typeof available).toBe('boolean')
  })
})
