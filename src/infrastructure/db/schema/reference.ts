import { sql } from 'drizzle-orm'
import {
  bigint,
  char,
  check,
  date,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

import type { Scheme } from '../../../application/cases/index.js'

// Tenants and the reference data they rely on. Mirrors migrations 0002–0004.

export const tenants = pgTable(
  'tenants',
  {
    base_currency: char('base_currency', { length: 3 }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    display_timezone: text('display_timezone').notNull().default('UTC'),
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
  },
  (t) => [
    check('tenants_name_check', sql`length(${t.name}) BETWEEN 1 AND 200`),
    check('tenants_base_currency_check', sql`${t.base_currency} ~ '^[A-Z]{3}$'`),
  ],
)

export const responseWindows = pgTable(
  'response_windows',
  {
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deadline_tz: text('deadline_tz').notNull().default('UTC'),
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    reason_code: text('reason_code'),
    scheme: text('scheme').$type<Scheme>().notNull(),
    window_days: integer('window_days').notNull(),
  },
  (t) => [
    check('response_windows_scheme_check', sql`${t.scheme} IN ('VISA', 'MASTERCARD', 'OTHER')`),
    check('response_windows_reason_code_check', sql`length(${t.reason_code}) BETWEEN 1 AND 20`),
    check('response_windows_window_days_check', sql`${t.window_days} BETWEEN 1 AND 365`),
    unique('response_windows_scheme_reason_code_key')
      .on(t.scheme, t.reason_code)
      .nullsNotDistinct(),
  ],
)

export const fxRates = pgTable(
  'fx_rates',
  {
    base_currency: char('base_currency', { length: 3 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    rate: numeric('rate', { precision: 20, scale: 10 }).notNull(),
    rate_date: date('rate_date', { mode: 'string' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.currency, t.base_currency], name: 'fx_rates_pkey' }),
    check('fx_rates_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('fx_rates_base_currency_check', sql`${t.base_currency} ~ '^[A-Z]{3}$'`),
    check('fx_rates_rate_check', sql`${t.rate} > 0`),
  ],
)
