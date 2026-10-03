import type { CaseStore } from './ports.js'
import type { CaseRecord, Principal, QueuePageQuery, QueueSummary } from './types.js'

import { type QueueState, queueState } from '../../domain/dispute/index.js'
import { CaseError } from './errors.js'

export interface StuckQueueInput {
  after: QueuePageQuery['after']
  limit: number
  riskWindowDays: number
  states: readonly QueueState[]
}

export interface StuckQueueItem {
  case: CaseRecord
  deadlineState: QueueState
  // Negative once the deadline has passed.
  secondsToDeadline: number
}

export interface StuckQueueResult {
  baseCurrency: string
  generatedAt: Date
  items: StuckQueueItem[]
  // Where the next page starts, or null when this was the last one.
  next: QueuePageQuery['after']
  summary: QueueSummary
}

const DAY_MS = 86_400_000

// The page and the summary must describe the same instant (generated_at).
const SNAPSHOT = { snapshot: true }

// GET /reports/stuck-queue: where a bank is losing money. The summary always covers all three
// states; the page lists only the requested ones (by default the actionable at_risk and breached),
// ordered by amount in the tenant's base currency, then id (docs/DOMAIN.md, D-28).
export function stuckQueue(
  store: CaseStore,
  principal: Principal,
  input: StuckQueueInput,
): Promise<StuckQueueResult> {
  return store.transaction(async (tx) => {
    const now = await tx.now()
    const tenant = await tx.tenant(principal.tenantId)
    if (!tenant) throw new CaseError('tenant_not_found', 'the tenant in the token does not exist')

    const window = {
      horizon: new Date(now.getTime() + input.riskWindowDays * DAY_MS),
      lookback: new Date(now.getTime() - input.riskWindowDays * DAY_MS),
      now,
      tenantId: tenant.id,
    }
    // One row more than the page tells whether another page follows.
    const rows = await tx.queuePage({
      ...window,
      after: input.after,
      limit: input.limit + 1,
      states: new Set(input.states),
    })
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)

    return {
      baseCurrency: tenant.base_currency,
      generatedAt: now,
      items: page.map((record) => {
        const state = queueState(
          {
            deadlineAt: record.deadline_at,
            decidedByRule: record.decided_by_rule,
            status: record.status,
          },
          now,
        )
        if (!state) throw new Error(`case ${record.id} was selected but is not in the queue`)
        return {
          case: record,
          deadlineState: state,
          secondsToDeadline: Math.round((record.deadline_at.getTime() - now.getTime()) / 1000),
        }
      }),
      next:
        rows.length > input.limit && last
          ? { amount_base_minor: last.amount_base_minor, id: last.id }
          : null,
      summary: await tx.queueSummary(window),
    }
  }, SNAPSHOT)
}
