import type { QueueState } from '../../domain/dispute/index.js'
import type { RuleKey } from '../../domain/rules/index.js'
import type { Actor, CaseStatus } from '../../domain/shared/index.js'

// A row of the `cases` projection. Property names match the table, so the Postgres adapter can
// return rows as they are; infrastructure asserts the two shapes stay identical.
export interface CaseRecord {
  amount_base_minor: bigint
  amount_minor: bigint
  base_currency: string
  created_at: Date
  currency: string
  deadline_at: Date
  deadline_tz: string
  deadline_window_days: number
  deadline_window_id: number
  decided_by_rule: RuleKey
  external_ref: string
  fx_rate: string
  fx_rate_date: string
  id: string
  presentment_date: string
  reason_code: string
  scheme: Scheme
  status: CaseStatus
  tenant_id: string
  updated_at: Date
  version: number
}

export interface FxRateRecord {
  rate: string
  rate_date: string
}

export type NewCaseRecord = Omit<CaseRecord, 'created_at' | 'id' | 'updated_at'>

// Who is calling, as established by the verified token. Never built from request input.
export interface Principal {
  actor: Actor
  tenantId: string
}

// One page of the stuck queue: the selected states, ordered by amount_base_minor then id, both
// descending, starting strictly after `after` (keyset pagination).
export interface QueuePageQuery extends QueueWindow {
  after: { amount_base_minor: bigint; id: string } | null
  limit: number
  states: ReadonlySet<QueueState>
}

export type QueueSummary = Record<QueueState, { amount_base_minor: bigint; count: number }>

// The instants that bound the report: at_risk up to `horizon`, breached back to `lookback`.
export interface QueueWindow {
  horizon: Date
  lookback: Date
  now: Date
  tenantId: string
}

export interface ResponseWindowRecord {
  deadline_tz: string
  id: number
  window_days: number
}

export type Scheme = 'MASTERCARD' | 'OTHER' | 'VISA'

export interface TenantRecord {
  base_currency: string
  id: string
}
