import type { CaseTransaction } from './ports.js'
import type { CaseStore } from './ports.js'
import type { CaseRecord, Principal, Scheme } from './types.js'

import { computeDeadline, parseIsoDate } from '../../domain/deadline/index.js'
import { decideCreation } from '../../domain/dispute/index.js'
import { isSupportedCurrency, toBaseMinor } from '../../domain/money/index.js'
import { resolveRuleOrder } from '../../domain/rules/index.js'
import { CaseError } from './errors.js'

export interface CreateCaseInput {
  amount_minor: bigint
  currency: string
  external_ref: string
  presentment_date: string
  reason: null | string
  reason_code: string
  scheme: Scheme
}

export interface CreateCaseResult {
  case: CaseRecord
  // false when the same case already existed: a retried request returns it unchanged.
  created: boolean
}

// POST /cases. Idempotent on (tenant, external_ref): the same payload returns the existing case,
// a different one is a conflict (D-29). A case whose deadline has already passed is LOST in the
// same transaction (D-28).
export function createCase(
  store: CaseStore,
  principal: Principal,
  input: CreateCaseInput,
): Promise<CreateCaseResult> {
  return store.transaction(async (tx) => {
    const now = await tx.now()

    const tenant = await tx.tenant(principal.tenantId)
    if (!tenant) throw new CaseError('tenant_not_found', 'the tenant in the token does not exist')

    const existing = await tx.caseByExternalRef(tenant.id, input.external_ref)
    if (existing) return sameCaseOrConflict(existing, input)

    parseIsoDate(input.presentment_date)
    if (input.presentment_date > now.toISOString().slice(0, 10)) {
      throw new CaseError('presentment_in_future', 'presentment_date is after today (UTC)')
    }

    if (!isSupportedCurrency(input.currency)) {
      throw new CaseError('unsupported_currency', `currency ${input.currency} is not supported`)
    }
    const fx = await tx.fxRate(input.currency, tenant.base_currency)
    if (!fx) {
      throw new CaseError(
        'unsupported_currency',
        `no rate from ${input.currency} to the tenant's base currency ${tenant.base_currency}`,
      )
    }

    const window = await tx.responseWindow(input.scheme, input.reason_code)
    if (!window) {
      throw new CaseError('response_window_missing', `no response window for ${input.scheme}`)
    }

    const deadlineAt = computeDeadline(
      input.presentment_date,
      window.window_days,
      window.deadline_tz,
    )
    const drafts = decideCreation({
      actor: principal.actor,
      deadlineAt,
      deadlineWindowDays: window.window_days,
      now,
      reason: input.reason,
      ruleOrder: resolveRuleOrder(await tx.ruleConfig(tenant.id)),
    })
    const last = drafts[drafts.length - 1]
    if (!last?.ruleKey) throw new Error('decideCreation returned no deciding event')

    const inserted = await tx.insertCase({
      amount_base_minor: toBaseMinor(
        input.amount_minor,
        input.currency,
        tenant.base_currency,
        fx.rate,
      ),
      amount_minor: input.amount_minor,
      base_currency: tenant.base_currency,
      currency: input.currency,
      deadline_at: deadlineAt,
      deadline_tz: window.deadline_tz,
      deadline_window_days: window.window_days,
      deadline_window_id: window.id,
      decided_by_rule: last.ruleKey,
      external_ref: input.external_ref,
      fx_rate: fx.rate,
      fx_rate_date: fx.rate_date,
      presentment_date: input.presentment_date,
      reason_code: input.reason_code,
      scheme: input.scheme,
      status: last.to,
      tenant_id: tenant.id,
      version: drafts.length,
    })

    // Lost a race with a concurrent request for the same external_ref: answer as if it had
    // arrived second, which it did.
    if (!inserted) return raceLoser(tx, tenant.id, input)

    await tx.appendEvents(
      inserted,
      drafts.map((draft, index) => ({ draft, seq: index + 1 })),
    )
    return { case: inserted, created: true }
  })
}

async function raceLoser(
  tx: CaseTransaction,
  tenantId: string,
  input: CreateCaseInput,
): Promise<CreateCaseResult> {
  const winner = await tx.caseByExternalRef(tenantId, input.external_ref)
  if (!winner) throw new Error('insert conflicted but no case was found')
  return sameCaseOrConflict(winner, input)
}

function sameCaseOrConflict(existing: CaseRecord, input: CreateCaseInput): CreateCaseResult {
  const same =
    existing.amount_minor === input.amount_minor &&
    existing.currency === input.currency &&
    existing.scheme === input.scheme &&
    existing.reason_code === input.reason_code &&
    existing.presentment_date === input.presentment_date
  if (!same) {
    throw new CaseError(
      'external_ref_conflict',
      'a case with this external_ref already exists with different values',
    )
  }
  return { case: existing, created: false }
}
