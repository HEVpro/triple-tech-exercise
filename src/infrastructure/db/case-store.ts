import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  isNull,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'
import { unionAll } from 'drizzle-orm/pg-core'

import type {
  CaseStore,
  CaseTransaction,
  QueuePageQuery,
  Scheme,
} from '../../application/cases/index.js'
import type { QueueState } from '../../domain/dispute/index.js'
import type { RecordedEvent } from '../../domain/events/index.js'
import type { RuleKey } from '../../domain/rules/index.js'
import type { CaseStatus } from '../../domain/shared/index.js'

import * as schema from './schema/index.js'

const { caseEvents, cases, fxRates, responseWindows, tenantRuleConfig, tenants } = schema

type Db = NodePgDatabase<typeof schema>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

// The Postgres adapter for the CaseStore port, built on Drizzle queries. Rows are returned as
// Drizzle types them: the port's signatures make the compiler check that a `cases` row is a
// CaseRecord (reads) and that a NewCaseRecord is a valid insert (writes).
export function postgresCaseStore(db: Db): CaseStore {
  return {
    transaction: (work, options) =>
      db.transaction(
        (tx) => work(caseTransaction(tx)),
        options?.snapshot ? { accessMode: 'read only', isolationLevel: 'repeatable read' } : {},
      ),
  }
}

function caseTransaction(tx: Tx): CaseTransaction {
  return {
    async advance(record, status: CaseStatus, decidedByRule: RuleKey) {
      const [row] = await tx
        .update(cases)
        .set({
          decided_by_rule: decidedByRule,
          status,
          updated_at: sql`now()`,
          version: sql`${cases.version} + 1`,
        })
        .where(eq(cases.id, record.id))
        .returning()
      if (!row) throw new Error(`case ${record.id} vanished inside its own transaction`)
      return row
    },

    async appendEvents(record, events) {
      if (events.length === 0) return
      await tx.insert(caseEvents).values(
        events.map(({ draft, seq }) => ({
          actor_id: draft.actor.id,
          actor_type: draft.actor.type,
          case_id: record.id,
          event_type: draft.type,
          from_status: draft.from,
          metadata: draft.metadata,
          // The case_events_guard trigger stamps recorded_at with now(); occurred_at equals it
          // unless the domain set a business time (only DEADLINE_EXPIRED does).
          occurred_at: draft.occurredAt ?? sql`now()`,
          reason: draft.reason,
          recorded_at: sql`now()`,
          rule_key: draft.ruleKey,
          ruleset_version: draft.rulesetVersion,
          seq,
          tenant_id: record.tenant_id,
          to_status: draft.to,
        })),
      )
    },

    async caseByExternalRef(tenantId, externalRef) {
      const [row] = await tx
        .select()
        .from(cases)
        .where(and(eq(cases.tenant_id, tenantId), eq(cases.external_ref, externalRef)))
      return row ?? null
    },

    async caseById(tenantId, id, options) {
      const query = tx
        .select()
        .from(cases)
        .where(and(eq(cases.tenant_id, tenantId), eq(cases.id, id)))
      const [row] = options?.forUpdate ? await query.for('update') : await query
      return row ?? null
    },

    async dueForExpiry(now, limit) {
      const rows = await tx
        .select()
        .from(cases)
        .where(and(eq(cases.status, 'OPEN'), lte(cases.deadline_at, now)))
        .orderBy(asc(cases.deadline_at))
        .limit(limit)
        .for('update', { skipLocked: true })
      return rows
    },

    async events(caseId) {
      const rows = await tx
        .select()
        .from(caseEvents)
        .where(eq(caseEvents.case_id, caseId))
        .orderBy(asc(caseEvents.seq))
      return rows.map(toRecordedEvent)
    },

    async fxRate(currency, baseCurrency) {
      const [row] = await tx
        .select({ rate: fxRates.rate, rate_date: fxRates.rate_date })
        .from(fxRates)
        .where(and(eq(fxRates.currency, currency), eq(fxRates.base_currency, baseCurrency)))
      return row ?? null
    },

    async insertCase(values) {
      const [row] = await tx.insert(cases).values(values).onConflictDoNothing().returning()
      return row ?? null
    },

    async now() {
      const result = await tx.execute<{ now: Date | string }>(sql`SELECT now() AS now`)
      const value = result.rows[0]?.now
      if (value === undefined) throw new Error('SELECT now() returned no row')
      return new Date(value)
    },

    async queuePage(query) {
      const parts = queueParts(query).map((where) =>
        tx
          .select({ amount_base_minor: cases.amount_base_minor, id: cases.id })
          .from(cases)
          .where(and(eq(cases.tenant_id, query.tenantId), where, keysetAfter(query.after))),
      )
      const [first, second, ...rest] = parts
      if (!first) return []

      // Late materialisation: the page is chosen from the covering indexes alone (ids and
      // amounts), and only the rows on the page are read from the table.
      const ordered = (second ? unionAll(first, second, ...rest) : first)
        .orderBy(desc(cases.amount_base_minor), desc(cases.id))
        .limit(query.limit)
        .as('page')

      const rows = await tx
        .select(getTableColumns(cases))
        .from(ordered)
        .innerJoin(cases, eq(cases.id, ordered.id))
        .orderBy(desc(ordered.amount_base_minor), desc(ordered.id))
      return rows
    },

    async queueSummary(window) {
      const tenant = eq(cases.tenant_id, window.tenantId)
      const amount = cases.amount_base_minor
      const inQueue = (filter: SQL) => ({
        amount: sql<string>`coalesce(sum(${amount}) filter (where ${filter}), 0)`,
        count: sql<number>`count(*) filter (where ${filter})`.mapWith(Number),
      })
      const atRisk = sql`${OPEN} and ${cases.deadline_at} > ${window.now}`
      const overdue = sql`${OPEN} and ${cases.deadline_at} <= ${window.now}`

      const [open] = await tx
        .select({
          at_risk: inQueue(atRisk),
          overdue: inQueue(overdue),
          responded: inQueue(UNDER_REVIEW),
        })
        .from(cases)
        .where(and(tenant, OPEN_OR_UNDER_REVIEW, lte(cases.deadline_at, window.horizon)))
      const [lost] = await tx
        .select(inQueue(sql`true`))
        .from(cases)
        .where(and(tenant, LOST_BY_DEADLINE, gte(cases.deadline_at, window.lookback)))
      if (!open || !lost) throw new Error('aggregate queries always return one row')

      return {
        at_risk: { amount_base_minor: BigInt(open.at_risk.amount), count: open.at_risk.count },
        breached: {
          amount_base_minor: BigInt(open.overdue.amount) + BigInt(lost.amount),
          count: open.overdue.count + lost.count,
        },
        responded: {
          amount_base_minor: BigInt(open.responded.amount),
          count: open.responded.count,
        },
      }
    },

    // The row for the reason code wins over the scheme default (reason_code IS NULL).
    async responseWindow(scheme: Scheme, reasonCode) {
      const [row] = await tx
        .select({
          deadline_tz: responseWindows.deadline_tz,
          id: responseWindows.id,
          window_days: responseWindows.window_days,
        })
        .from(responseWindows)
        .where(
          and(
            eq(responseWindows.scheme, scheme),
            or(eq(responseWindows.reason_code, reasonCode), isNull(responseWindows.reason_code)),
          ),
        )
        .orderBy(sql`${responseWindows.reason_code} NULLS LAST`)
        .limit(1)
      return row ?? null
    },

    async ruleConfig(tenantId) {
      const rows = await tx
        .select({ priority: tenantRuleConfig.priority, rule_key: tenantRuleConfig.rule_key })
        .from(tenantRuleConfig)
        .where(eq(tenantRuleConfig.tenant_id, tenantId))
      return rows.map((row) => ({ priority: row.priority, ruleKey: row.rule_key }))
    },

    async tenant(id) {
      const [row] = await tx
        .select({ base_currency: tenants.base_currency, id: tenants.id })
        .from(tenants)
        .where(eq(tenants.id, id))
      return row ?? null
    },
  }
}

// The row shapes are trusted: the CHECK constraints guarantee every combination the domain types
// allow, and the metadata was validated by the domain before it was written.
function toRecordedEvent(row: typeof caseEvents.$inferSelect): RecordedEvent {
  return {
    actor: { id: row.actor_id, type: row.actor_type },
    from: row.from_status,
    metadata: row.metadata,
    occurredAt: row.occurred_at,
    reason: row.reason,
    recordedAt: row.recorded_at,
    ruleKey: row.rule_key,
    rulesetVersion: row.ruleset_version,
    seq: row.seq,
    to: row.to_status,
    type: row.event_type,
  } as RecordedEvent
}

// Status and rule constants are written as SQL literals, not bound parameters, so the planner can
// prove they match the partial indexes' WHERE clauses (cases_queue_idx, cases_queue_breached_idx).
const OPEN = sql`${cases.status} = 'OPEN'`
const UNDER_REVIEW = sql`${cases.status} = 'UNDER_REVIEW'`
const OPEN_OR_UNDER_REVIEW = sql`${cases.status} in ('OPEN', 'UNDER_REVIEW')`
const LOST_BY_DEADLINE = sql`${cases.status} = 'LOST' and ${cases.decided_by_rule} = 'deadline_passed'`

// Strictly after the last row of the previous page, in (amount_base_minor, id) descending order.
function keysetAfter(after: QueuePageQuery['after']): SQL | undefined {
  if (!after) return undefined
  return or(
    lt(cases.amount_base_minor, after.amount_base_minor),
    and(eq(cases.amount_base_minor, after.amount_base_minor), lt(cases.id, after.id)),
  )
}

// One WHERE clause per index-backed part of the queue. OPEN cases split at `now` into at_risk and
// breached-but-not-yet-swept; when both are wanted they are read as one range.
function queueParts(query: QueuePageQuery): SQL[] {
  const wants = (state: QueueState) => query.states.has(state)
  const parts: (SQL | undefined)[] = []

  if (wants('at_risk') && wants('breached')) {
    parts.push(and(OPEN, lte(cases.deadline_at, query.horizon)))
  } else if (wants('at_risk')) {
    parts.push(and(OPEN, gt(cases.deadline_at, query.now), lte(cases.deadline_at, query.horizon)))
  } else if (wants('breached')) {
    parts.push(and(OPEN, lte(cases.deadline_at, query.now)))
  }
  if (wants('responded')) parts.push(and(UNDER_REVIEW, lte(cases.deadline_at, query.horizon)))
  if (wants('breached')) parts.push(and(LOST_BY_DEADLINE, gte(cases.deadline_at, query.lookback)))

  return parts.filter((part): part is SQL => part !== undefined)
}
