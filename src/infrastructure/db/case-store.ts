import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm'

import type { CaseStore, CaseTransaction, Scheme } from '../../application/cases/index.js'
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
