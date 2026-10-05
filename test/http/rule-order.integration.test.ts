import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DevTenantSlug } from '../../scripts/dev-tenants.js'

import { DEV_RULE_ORDER, DEV_TENANTS } from '../../scripts/dev-tenants.js'
import { sweepDeadlines } from '../../src/application/cases/index.js'
import { startApi, type TestApi } from '../support/api.js'
import { databaseAvailable } from '../support/temp-database.js'

// The brief asks for "configurable, ordered rules". The order is data, one row per tenant and
// rule in tenant_rule_config. These tests prove a row changes a real decision, through the API
// and the database, and what it cannot change.
//
// The only decision the order affects is the one below: no evidence, the deadline has passed,
// and the scheme's outcome arrives before the sweeper has recorded the loss.
//   Acme    no configuration: the deadline rule comes first, so the case is lost.
//   Globex  scheme_outcome first: what the scheme decided stands.
const available = await databaseAvailable()
let api: TestApi
const tokens = {} as Record<DevTenantSlug, string>

beforeAll(async () => {
  if (!available) return
  api = await startApi()
  tokens.acme = await api.token('acme')
  tokens.globex = await api.token('globex')
  await configureGlobex()
})

afterAll(async () => {
  if (available) await api.drop()
})

// The same configuration npm run dev:seed gives Globex.
async function configureGlobex(): Promise<void> {
  for (const row of DEV_RULE_ORDER) {
    await api.owner.query(
      `INSERT INTO tenant_rule_config (tenant_id, rule_key, priority) VALUES ($1, $2, $3)`,
      [row.tenant_id, row.rule_key, row.priority],
    )
  }
}

const won = {
  reason: 'scheme ruled for the issuer',
  scheme_decided_on: new Date().toISOString().slice(0, 10),
  scheme_decision_ref: 'VROL-42',
  to: 'WON',
}

// An OPEN case whose deadline has passed and the sweeper has not recorded yet. The API cannot
// produce it directly (a case born late is LOST at once), so the owner moves the deadline back.
async function overdueOpenCase(tenant: DevTenantSlug): Promise<string> {
  const { body } = await api.request('POST', '/cases', {
    body: {
      amount_cents: 5_000,
      currency: DEV_TENANTS[tenant].base_currency,
      external_ref: `BANK-${crypto.randomUUID()}`,
      presentment_date: new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10),
      reason_code: '13.1',
      scheme: 'VISA',
    },
    token: tokens[tenant],
  })
  const id = String(body['id'])
  await api.owner.query(`UPDATE cases SET deadline_at = now() - interval '1 hour' WHERE id = $1`, [
    id,
  ])
  return id
}

describe.skipIf(!available)('rule order per tenant', () => {
  it('with no configuration, the deadline decides before a late scheme outcome', async () => {
    const id = await overdueOpenCase('acme')

    const { body, status } = await api.request('POST', `/cases/${id}/transitions`, {
      body: won,
      token: tokens.acme,
    })

    expect(status).toBe(409)
    expect(body).toMatchObject({
      error: {
        code: 'rule_conflict',
        details: { decided_by: { rule_key: 'deadline_passed', status: 'LOST' } },
      },
    })
  })

  it('with scheme_outcome first, the same request records what the scheme decided', async () => {
    const id = await overdueOpenCase('globex')

    const { body, status } = await api.request('POST', `/cases/${id}/transitions`, {
      body: won,
      token: tokens.globex,
    })

    expect(status).toBe(201)
    expect(body).toMatchObject({
      case: { decided_by_rule: 'scheme_outcome', status: 'WON' },
      event: { from: 'OPEN', rule_key: 'scheme_outcome', to: 'WON' },
    })
  })

  it('does not switch the deadline off: with no outcome, the sweeper still loses the case', async () => {
    const id = await overdueOpenCase('globex')

    await sweepDeadlines(api.store, {
      batchSize: 100,
      maxBatches: 10,
      sweepRunId: crypto.randomUUID(),
    })

    const { body } = await api.request('GET', `/cases/${id}`, { token: tokens.globex })
    expect(body).toMatchObject({ decided_by_rule: 'deadline_passed', status: 'LOST' })
  })

  it('does not rewrite the past: a decided case keeps its decision when the order changes', async () => {
    const id = await overdueOpenCase('globex')
    await api.request('POST', `/cases/${id}/transitions`, { body: won, token: tokens.globex })

    await api.owner.query(`DELETE FROM tenant_rule_config WHERE tenant_id = $1`, [
      DEV_TENANTS.globex.id,
    ])
    try {
      const { body } = await api.request('GET', `/cases/${id}/history`, { token: tokens.globex })

      expect(body).toMatchObject({
        decided_by: { rule_key: 'scheme_outcome' },
        state: { status: 'WON' },
      })
    } finally {
      await configureGlobex()
    }
  })

  it('skips itself when postgres is unreachable', () => {
    expect(typeof available).toBe('boolean')
  })
})
