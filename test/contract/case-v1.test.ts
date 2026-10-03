import { describe, expect, it } from 'vitest'

import { satisfiesCaseV1 } from './case-v1.js'

// The guard itself: it must accept additive changes and reject breaking ones. The API tests
// then run every case response through it.
const v1Case = {
  amount_base_minor: 10_000,
  amount_cents: 10_000,
  amount_minor: 10_000,
  base_currency: 'EUR',
  created_at: '2026-10-03T12:00:00.000Z',
  currency: 'EUR',
  currency_exponent: 2,
  deadline_at: '2026-11-18T00:00:00.000Z',
  deadline_tz: 'UTC',
  deadline_window_days: 45,
  decided_by_rule: 'default_open',
  external_ref: 'BANK-1',
  fx_rate: '1.0000000000',
  fx_rate_date: '2026-01-01',
  id: '0b8f0e6c-2f8e-4b4e-9c53-7b2a3d0e1f10',
  presentment_date: '2026-10-03',
  reason_code: '10.4',
  scheme: 'VISA',
  status: 'OPEN',
  updated_at: '2026-10-03T12:00:00.000Z',
  version: 1,
}

describe('the v1 case contract', () => {
  it('accepts a v1 response', () => {
    expect(satisfiesCaseV1(v1Case)).toBe(true)
  })

  it('accepts an additive change: a new field does not break integrated banks', () => {
    expect(satisfiesCaseV1({ ...v1Case, assigned_to: 'analyst-7' })).toBe(true)
  })

  it('rejects removing a field banks read, such as amount_cents', () => {
    const withoutAmountCents: Record<string, unknown> = { ...v1Case }
    Reflect.deleteProperty(withoutAmountCents, 'amount_cents')
    expect(() => satisfiesCaseV1(withoutAmountCents)).toThrow(/amount_cents/)
  })

  it('rejects changing the type of a field', () => {
    expect(() => satisfiesCaseV1({ ...v1Case, amount_cents: '10000' })).toThrow(/amount_cents/)
  })

  it('rejects a new status value that clients cannot handle', () => {
    expect(() => satisfiesCaseV1({ ...v1Case, status: 'EXPIRED' })).toThrow(/status/)
  })
})
