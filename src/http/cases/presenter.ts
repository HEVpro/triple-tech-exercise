import type { z } from '@hono/zod-openapi'

import type { CaseRecord } from '../../application/cases/index.js'
import type { HistoryView } from '../../domain/dispute/index.js'
import type { EventDraft, RecordedEvent } from '../../domain/events/index.js'
import type { CaseSchema, EventSchema, HistorySchema } from './schemas.js'

import { currencyExponent } from '../../domain/money/index.js'

type CaseJson = z.infer<typeof CaseSchema>
type EventJson = z.infer<typeof EventSchema>

// Rows and domain values to the JSON contract. bigint amounts become JSON numbers; the request
// schema bounds them so the conversion is exact.

export function toCaseJson(record: CaseRecord): CaseJson {
  return {
    amount_base_minor: Number(record.amount_base_minor),
    amount_cents: Number(record.amount_minor),
    amount_minor: Number(record.amount_minor),
    base_currency: record.base_currency,
    created_at: record.created_at.toISOString(),
    currency: record.currency,
    currency_exponent: currencyExponent(record.currency),
    deadline_at: record.deadline_at.toISOString(),
    deadline_tz: record.deadline_tz,
    deadline_window_days: record.deadline_window_days,
    decided_by_rule: record.decided_by_rule,
    external_ref: record.external_ref,
    fx_rate: record.fx_rate,
    fx_rate_date: record.fx_rate_date,
    id: record.id,
    presentment_date: record.presentment_date,
    reason_code: record.reason_code,
    scheme: record.scheme,
    status: record.status,
    updated_at: record.updated_at.toISOString(),
    version: record.version,
  }
}

export function toEventJson(event: RecordedEvent): EventJson {
  return {
    actor: { id: event.actor.id, type: event.actor.type },
    from: event.from,
    metadata: event.metadata,
    occurred_at: event.occurredAt.toISOString(),
    reason: event.reason,
    recorded_at: event.recordedAt.toISOString(),
    rule_key: event.ruleKey,
    ruleset_version: event.rulesetVersion,
    seq: event.seq,
    to: event.to,
    type: event.type,
  }
}

// The case as its log recorded it at `asOf`: the immutable fields from the row, the status and
// version from the folded events.
export function toHistoryJson(
  record: CaseRecord,
  view: HistoryView,
  asOf: Date,
): z.infer<typeof HistorySchema> {
  return {
    as_of: asOf.toISOString(),
    case_id: record.id,
    decided_by: view.decidedBy
      ? {
          rule_key: view.decidedBy.ruleKey,
          ruleset_version: view.decidedBy.rulesetVersion,
          seq: view.decidedBy.seq,
        }
      : null,
    events: view.events.map(toEventJson),
    state: view.state
      ? {
          ...toCaseJson(record),
          decided_by_rule: view.decidedBy?.ruleKey ?? record.decided_by_rule,
          status: view.state.status,
          updated_at: (view.events.at(-1)?.recordedAt ?? record.updated_at).toISOString(),
          version: view.state.version,
        }
      : null,
    truncated: view.truncated,
  }
}

// An event just written in the same transaction as `record`: its seq is the record's version
// and both clocks are that transaction's now(), which is also the record's updated_at.
export function toNewEventJson(record: CaseRecord, draft: EventDraft): EventJson {
  return toEventJson({
    ...draft,
    occurredAt: draft.occurredAt ?? record.updated_at,
    recordedAt: record.updated_at,
    seq: record.version,
  })
}
