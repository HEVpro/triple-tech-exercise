import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

import type { Scheme } from '../../../application/cases/index.js'
import type { EventType } from '../../../domain/events/index.js'
import type { ConfigurableRuleKey, RuleKey } from '../../../domain/rules/index.js'
import type { ActorType, CaseStatus } from '../../../domain/shared/index.js'

import { responseWindows, tenants } from './reference.js'

// The case projection, the event log and the per-tenant rule configuration. Mirrors migrations
// 0005–0007. Constraints are named exactly as PostgreSQL named them in the hand-written SQL, so
// drizzle-kit never tries to rename them. What drizzle-kit cannot express (the append-only trigger, grants, and the
// CONCURRENTLY … INCLUDE report indexes) lives in custom migrations and is not declared here.

const STATUSES = sql`('OPEN', 'UNDER_REVIEW', 'WON', 'LOST')`
const RULE_KEYS = sql`('deadline_passed', 'evidence_filed', 'scheme_outcome', 'default_open')`

export const cases = pgTable(
  'cases',
  {
    amount_base_minor: bigint('amount_base_minor', { mode: 'bigint' }).notNull(),
    amount_minor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    base_currency: char('base_currency', { length: 3 }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    currency: char('currency', { length: 3 }).notNull(),
    deadline_at: timestamp('deadline_at', { withTimezone: true }).notNull(),
    deadline_tz: text('deadline_tz').notNull(),
    deadline_window_days: integer('deadline_window_days').notNull(),
    deadline_window_id: bigint('deadline_window_id', { mode: 'number' }).notNull(),
    decided_by_rule: text('decided_by_rule').$type<RuleKey>().notNull(),
    external_ref: text('external_ref').notNull(),
    fx_rate: numeric('fx_rate', { precision: 20, scale: 10 }).notNull(),
    fx_rate_date: date('fx_rate_date', { mode: 'string' }).notNull(),
    id: uuid('id').primaryKey().defaultRandom(),
    presentment_date: date('presentment_date', { mode: 'string' }).notNull(),
    reason_code: text('reason_code').notNull(),
    scheme: text('scheme').$type<Scheme>().notNull(),
    status: text('status').$type<CaseStatus>().notNull(),
    tenant_id: uuid('tenant_id').notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenant_id],
      foreignColumns: [tenants.id],
      name: 'cases_tenant_id_fkey',
    }),
    foreignKey({
      columns: [t.deadline_window_id],
      foreignColumns: [responseWindows.id],
      name: 'cases_deadline_window_id_fkey',
    }),
    unique('cases_tenant_external_ref_key').on(t.tenant_id, t.external_ref),
    check('cases_external_ref_check', sql`length(${t.external_ref}) BETWEEN 1 AND 128`),
    check('cases_amount_minor_check', sql`${t.amount_minor} > 0`),
    check('cases_amount_base_minor_check', sql`${t.amount_base_minor} >= 0`),
    check('cases_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('cases_base_currency_check', sql`${t.base_currency} ~ '^[A-Z]{3}$'`),
    check('cases_fx_rate_check', sql`${t.fx_rate} > 0`),
    check('cases_scheme_check', sql`${t.scheme} IN ('VISA', 'MASTERCARD', 'OTHER')`),
    check('cases_reason_code_check', sql`length(${t.reason_code}) BETWEEN 1 AND 20`),
    check('cases_status_check', sql`${t.status} IN ${STATUSES}`),
    check('cases_decided_by_rule_check', sql`${t.decided_by_rule} IN ${RULE_KEYS}`),
    check('cases_version_check', sql`${t.version} >= 1`),
    check('cases_deadline_window_days_check', sql`${t.deadline_window_days} BETWEEN 1 AND 365`),
  ],
)

export const caseEvents = pgTable(
  'case_events',
  {
    actor_id: text('actor_id').notNull(),
    actor_type: text('actor_type').$type<ActorType>().notNull(),
    case_id: uuid('case_id').notNull(),
    event_type: text('event_type').$type<EventType>().notNull(),
    from_status: text('from_status').$type<CaseStatus>(),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Both clocks are stamped by the case_events_guard trigger; inserts pass now().
    occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull(),
    reason: text('reason'),
    recorded_at: timestamp('recorded_at', { withTimezone: true }).notNull(),
    rule_key: text('rule_key').$type<RuleKey>(),
    ruleset_version: integer('ruleset_version'),
    seq: integer('seq').notNull(),
    tenant_id: uuid('tenant_id').notNull(),
    to_status: text('to_status').$type<CaseStatus>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.case_id, t.seq], name: 'case_events_pkey' }),
    foreignKey({
      columns: [t.case_id],
      foreignColumns: [cases.id],
      name: 'case_events_case_id_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.tenant_id],
      foreignColumns: [tenants.id],
      name: 'case_events_tenant_id_fkey',
    }),
    check('case_events_seq_check', sql`${t.seq} >= 1`),
    check(
      'case_events_event_type_check',
      sql`${t.event_type} IN ('CASE_CREATED', 'EVIDENCE_FILED', 'SCHEME_OUTCOME_RECORDED', 'DEADLINE_EXPIRED', 'NOTE_ADDED')`,
    ),
    check('case_events_actor_type_check', sql`${t.actor_type} IN ('human', 'agent', 'system')`),
    check('case_events_actor_id_check', sql`length(${t.actor_id}) BETWEEN 1 AND 200`),
    check('case_events_from_status_check', sql`${t.from_status} IN ${STATUSES}`),
    check('case_events_to_status_check', sql`${t.to_status} IN ${STATUSES}`),
    check('case_events_rule_key_check', sql`${t.rule_key} IN ${RULE_KEYS}`),
    check('case_events_reason_check', sql`length(${t.reason}) <= 1000`),
    check(
      'case_events_metadata_check',
      sql`jsonb_typeof(${t.metadata}) = 'object' AND pg_column_size(${t.metadata}) <= 16384`,
    ),
    check(
      'case_events_created_from_check',
      sql`(${t.event_type} = 'CASE_CREATED') = (${t.from_status} IS NULL)`,
    ),
    check(
      'case_events_rule_presence_check',
      sql`(${t.event_type} = 'NOTE_ADDED') = (${t.rule_key} IS NULL AND ${t.ruleset_version} IS NULL)`,
    ),
    check(
      'case_events_system_actor_check',
      sql`(${t.actor_type} = 'system') = (${t.event_type} = 'DEADLINE_EXPIRED')`,
    ),
    check(
      'case_events_occurred_at_check',
      sql`${t.occurred_at} = ${t.recorded_at} OR (${t.event_type} = 'DEADLINE_EXPIRED' AND ${t.occurred_at} <= ${t.recorded_at})`,
    ),
  ],
)

export const tenantRuleConfig = pgTable(
  'tenant_rule_config',
  {
    enabled: boolean('enabled').notNull().default(true),
    priority: integer('priority').notNull(),
    rule_key: text('rule_key').$type<ConfigurableRuleKey>().notNull(),
    tenant_id: uuid('tenant_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.rule_key], name: 'tenant_rule_config_pkey' }),
    foreignKey({
      columns: [t.tenant_id],
      foreignColumns: [tenants.id],
      name: 'tenant_rule_config_tenant_id_fkey',
    }),
    unique('tenant_rule_config_priority_key').on(t.tenant_id, t.priority),
    check(
      'tenant_rule_config_rule_key_check',
      sql`${t.rule_key} IN ('deadline_passed', 'evidence_filed', 'scheme_outcome')`,
    ),
  ],
)
