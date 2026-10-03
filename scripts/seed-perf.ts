import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { parseArgs } from 'node:util'
import { Pool } from 'pg'
import { z } from 'zod'

import { loadMigrations, migrate } from '../src/infrastructure/db/migrator.js'
import { tenants } from '../src/infrastructure/db/schema/index.js'
import { DEV_TENANTS } from './dev-tenants.js'

// A realistic, reproducible volume in the development database itself, so it can be explored
// through the API with a dev token and every case has a complete, consistent history (D-2).
//
//   npm run seed:perf                      # 1 000 000 cases
//   npm run seed:perf -- --rows 100000     # a lighter run
//   npm run seed:perf -- --rows 10000000   # the brief's 10M, for whoever wants to repeat it
//
// The shape matters more than the count: most cases are closed, the open ones cluster in the last
// response window, one tenant dominates.
//   - Acme (the dev tenant, EUR) holds 80% of the cases; Globex (USD) and 19 small banks the rest;
//   - presentments spread over three years;
//   - deadline still ahead: 60% OPEN, 35% UNDER_REVIEW (evidence filed), 5% already decided;
//   - deadline passed: 45% WON, 35% LOST by the card network, 15% LOST by the deadline, 5% still
//     UNDER_REVIEW if the deadline was in the last 90 days (otherwise decided);
//   - amounts between 10 and 10 000 in major units, log-distributed; 70% in the tenant's base
//     currency, the rest in USD/EUR, GBP, JPY and KWD;
//   - one case with 400 events (PERF-HISTORY-400), for review scenario 3.
//
// Every case gets the events that explain its status, so the projection equals its log
// (invariant 3) and GET /cases/:id/history tells the whole story:
//   OPEN                   CASE_CREATED
//   UNDER_REVIEW           CASE_CREATED, EVIDENCE_FILED
//   decided by the network CASE_CREATED, EVIDENCE_FILED, SCHEME_OUTCOME_RECORDED
//   LOST by the deadline   CASE_CREATED, DEADLINE_EXPIRED (system, occurred_at = deadline_at)
//
// recorded_at is the database clock, by design (the trigger forbids anything else), so every
// seeded event is recorded at seeding time: history `as_of` an earlier instant shows nothing. The
// event log is append-only, so the seed runs once; to start over, reset the database.

const out = process.stdout.write.bind(process.stdout)
const fail = process.stderr.write.bind(process.stderr)

const { values } = parseArgs({ options: { rows: { default: '1000000', type: 'string' } } })
const args = z
  .object({ rows: z.coerce.number().int().min(1_000).max(50_000_000) })
  .safeParse(values)
const ownerUrl = z.url().safeParse(process.env['MIGRATION_DATABASE_URL'])

if (!args.success || !ownerUrl.success) {
  fail('usage: npm run seed:perf -- [--rows N]  (needs MIGRATION_DATABASE_URL)\n')
  process.exit(2)
}

const { rows } = args.data
const BIG_TENANT = DEV_TENANTS.acme.id
const SMALL_TENANTS = [
  DEV_TENANTS.globex.id,
  ...Array.from(
    { length: 19 },
    (_, i) => `44444444-4444-4444-8444-${String(i + 1).padStart(12, '0')}`,
  ),
]

// Drizzle expands a JS array into a list of parameters, so the array goes as one Postgres literal.
const SMALL_TENANT_ARRAY = `{${SMALL_TENANTS.join(',')}}`

// One connection: setseed() makes random() reproducible only within the same session.
const pool = new Pool({ connectionString: ownerUrl.data, max: 1 })
const db = drizzle({ client: pool })

const started = performance.now()
const elapsed = () => `${((performance.now() - started) / 1000).toFixed(1)}s`

try {
  await migrate(pool, await loadMigrations('migrations'))

  const seeded = await db.execute(sql`SELECT 1 FROM cases WHERE external_ref LIKE 'PERF-%' LIMIT 1`)
  if (seeded.rows.length > 0) {
    fail(
      'already seeded. The event log is append-only, so to start over:\n' +
        '  npm run db:reset && npm run db:migrate && npm run dev:seed && npm run seed:perf\n',
    )
    process.exit(1)
  }

  await db
    .insert(tenants)
    .values([
      ...Object.values(DEV_TENANTS),
      ...SMALL_TENANTS.slice(1).map((id, i) => ({
        base_currency: i % 2 === 0 ? 'EUR' : 'USD',
        id,
        name: `Perf Small Bank ${String(i + 1)}`,
      })),
    ])
    .onConflictDoNothing()

  await db.execute(sql`SELECT setseed(0.42)`)

  // Set-returning bulk generation has no query-builder equivalent, so this is SQL by design.
  await db.execute(sql`
    INSERT INTO cases (
      tenant_id, external_ref, amount_minor, currency, amount_base_minor, base_currency,
      fx_rate, fx_rate_date, scheme, reason_code, presentment_date, deadline_at,
      deadline_window_id, deadline_window_days, deadline_tz, status, decided_by_rule, version,
      created_at, updated_at
    )
    SELECT
      g.tenant_id, 'PERF-' || g.n, g.amount_minor, g.currency,
      -- Base currencies here are EUR or USD (exponent 2); JPY has 0 and KWD 3.
      round(g.amount_minor * fx.rate * 100
            / power(10, CASE g.currency WHEN 'JPY' THEN 0 WHEN 'KWD' THEN 3 ELSE 2 END))::bigint,
      t.base_currency, fx.rate, fx.rate_date, g.scheme,
      CASE g.scheme WHEN 'VISA' THEN '10.4' WHEN 'MASTERCARD' THEN '4853' ELSE '00' END,
      g.presentment_date,
      ((g.presentment_date + w.window_days + 1)::timestamp AT TIME ZONE 'UTC'),
      w.id, w.window_days, w.deadline_tz,
      s.status, s.rule,
      CASE s.rule WHEN 'default_open' THEN 1 WHEN 'scheme_outcome' THEN 3 ELSE 2 END,
      g.presentment_date::timestamp AT TIME ZONE 'UTC',
      g.presentment_date::timestamp AT TIME ZONE 'UTC'
    FROM (
      SELECT
        n,
        CASE WHEN random() < 0.8 THEN ${BIG_TENANT}::uuid
             ELSE (${SMALL_TENANT_ARRAY}::uuid[])[1 + floor(random() * ${SMALL_TENANTS.length})::int]
        END AS tenant_id,
        (current_date - floor(random() * 1095)::int) AS presentment_date,
        CASE WHEN random() < 0.55 THEN 'VISA' WHEN random() < 0.9 THEN 'MASTERCARD' ELSE 'OTHER' END AS scheme,
        floor(exp(ln(1000) + random() * ln(1000)))::bigint AS amount_minor,
        random() AS currency_roll,
        random() AS status_roll
      FROM generate_series(1, ${rows}) AS n
    ) AS r
    JOIN tenants t ON t.id = r.tenant_id
    CROSS JOIN LATERAL (
      SELECT r.n, r.tenant_id, r.presentment_date, r.scheme, r.status_roll,
        CASE
          WHEN r.currency_roll < 0.70 THEN t.base_currency
          WHEN r.currency_roll < 0.85 THEN CASE t.base_currency WHEN 'EUR' THEN 'USD' ELSE 'EUR' END
          WHEN r.currency_roll < 0.93 THEN 'GBP'
          WHEN r.currency_roll < 0.98 THEN 'JPY'
          ELSE 'KWD'
        END AS currency,
        CASE
          WHEN r.currency_roll >= 0.98 THEN r.amount_minor * 10   -- KWD: fils, three decimals
          ELSE r.amount_minor                                     -- JPY: whole yen
        END AS amount_minor
    ) AS g
    JOIN fx_rates fx ON fx.currency = g.currency AND fx.base_currency = t.base_currency
    JOIN response_windows w ON w.scheme = g.scheme AND w.reason_code IS NULL
    CROSS JOIN LATERAL (
      SELECT
        CASE
          WHEN g.presentment_date + w.window_days + 1 > current_date THEN
            CASE WHEN g.status_roll < 0.60 THEN 'OPEN'
                 WHEN g.status_roll < 0.95 THEN 'UNDER_REVIEW'
                 WHEN g.status_roll < 0.975 THEN 'WON' ELSE 'LOST' END
          ELSE
            CASE WHEN g.status_roll < 0.45 THEN 'WON'
                 WHEN g.status_roll < 0.95 THEN 'LOST'
                 WHEN g.presentment_date + w.window_days + 1 > current_date - 90 THEN 'UNDER_REVIEW'
                 ELSE 'WON' END
        END AS status,
        CASE
          WHEN g.presentment_date + w.window_days + 1 > current_date THEN
            CASE WHEN g.status_roll < 0.60 THEN 'default_open'
                 WHEN g.status_roll < 0.95 THEN 'evidence_filed' ELSE 'scheme_outcome' END
          ELSE
            CASE WHEN g.status_roll < 0.80 THEN 'scheme_outcome'
                 WHEN g.status_roll < 0.95 THEN 'deadline_passed'
                 WHEN g.presentment_date + w.window_days + 1 > current_date - 90 THEN 'evidence_filed'
                 ELSE 'scheme_outcome' END
        END AS rule
    ) AS s
  `)
  out(`cases: ${String(rows)} inserted (${elapsed()})\n`)

  // The events that explain each status, numbered 1..version (see the table above).
  await db.execute(sql`
    INSERT INTO case_events (
      case_id, seq, tenant_id, event_type, actor_type, actor_id, from_status, to_status,
      rule_key, ruleset_version, metadata, occurred_at, recorded_at
    )
    SELECT c.id, e.seq, c.tenant_id, e.event_type, e.actor_type, e.actor_id, e.from_status,
           e.to_status, e.rule_key, 1, e.metadata, e.occurred_at, now()
    FROM cases c
    CROSS JOIN LATERAL generate_series(1, c.version) AS s(seq)
    CROSS JOIN LATERAL (
      SELECT s.seq,
        CASE WHEN s.seq = 1 THEN 'CASE_CREATED'
             WHEN c.decided_by_rule = 'deadline_passed' THEN 'DEADLINE_EXPIRED'
             WHEN s.seq = 2 THEN 'EVIDENCE_FILED'
             ELSE 'SCHEME_OUTCOME_RECORDED' END AS event_type,
        CASE WHEN s.seq = 2 AND c.decided_by_rule = 'deadline_passed' THEN 'system' ELSE 'human' END AS actor_type,
        CASE WHEN s.seq = 2 AND c.decided_by_rule = 'deadline_passed' THEN 'deadline-sweeper' ELSE 'seed-analyst' END AS actor_id,
        CASE s.seq WHEN 1 THEN NULL WHEN 2 THEN 'OPEN' ELSE 'UNDER_REVIEW' END AS from_status,
        CASE WHEN s.seq = 1 THEN 'OPEN'
             WHEN c.decided_by_rule = 'deadline_passed' THEN 'LOST'
             WHEN s.seq = 2 THEN 'UNDER_REVIEW'
             ELSE c.status END AS to_status,
        CASE WHEN s.seq = 1 THEN 'default_open'
             WHEN c.decided_by_rule = 'deadline_passed' THEN 'deadline_passed'
             WHEN s.seq = 2 THEN 'evidence_filed'
             ELSE 'scheme_outcome' END AS rule_key,
        CASE WHEN s.seq = 1 THEN '{"source":"api"}'::jsonb
             WHEN c.decided_by_rule = 'deadline_passed' THEN jsonb_build_object(
               'deadline_at', to_char(c.deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'detected_by', 'sweeper', 'window_days', c.deadline_window_days)
             WHEN s.seq = 2 THEN '{"evidence_refs":["SEED-DOC-1"]}'::jsonb
             ELSE jsonb_build_object('outcome', c.status, 'scheme_decision_ref', 'SEED-' || c.external_ref,
                                     'scheme_decided_on', current_date) END AS metadata,
        CASE WHEN s.seq = 2 AND c.decided_by_rule = 'deadline_passed' THEN c.deadline_at ELSE now() END AS occurred_at
    ) AS e
    WHERE c.external_ref LIKE 'PERF-%'
  `)
  out(`events: inserted (${elapsed()})\n`)

  // Review scenario 3: one case with 400 events (created, evidence filed, 398 notes).
  await db.execute(sql`
    WITH c AS (
      INSERT INTO cases (
        tenant_id, external_ref, amount_minor, currency, amount_base_minor, base_currency,
        fx_rate, fx_rate_date, scheme, reason_code, presentment_date, deadline_at,
        deadline_window_id, deadline_window_days, deadline_tz, status, decided_by_rule, version
      )
      SELECT ${BIG_TENANT}::uuid, 'PERF-HISTORY-400', 125000, 'EUR', 125000, 'EUR', 1,
             '2026-01-01', 'VISA', '10.4', current_date - 10,
             ((current_date + 36)::timestamp AT TIME ZONE 'UTC'), w.id, 45, 'UTC',
             'UNDER_REVIEW', 'evidence_filed', 400
      FROM response_windows w WHERE w.scheme = 'VISA' AND w.reason_code IS NULL
      RETURNING id, tenant_id
    )
    INSERT INTO case_events (
      case_id, seq, tenant_id, event_type, actor_type, actor_id, from_status, to_status,
      rule_key, ruleset_version, metadata, occurred_at, recorded_at
    )
    SELECT c.id, s, c.tenant_id,
      CASE s WHEN 1 THEN 'CASE_CREATED' WHEN 2 THEN 'EVIDENCE_FILED' ELSE 'NOTE_ADDED' END,
      'human', 'seed-analyst',
      CASE s WHEN 1 THEN NULL WHEN 2 THEN 'OPEN' ELSE 'UNDER_REVIEW' END,
      CASE s WHEN 1 THEN 'OPEN' ELSE 'UNDER_REVIEW' END,
      CASE s WHEN 1 THEN 'default_open' WHEN 2 THEN 'evidence_filed' END,
      CASE WHEN s <= 2 THEN 1 END,
      CASE s WHEN 1 THEN '{"source":"api"}'::jsonb
             WHEN 2 THEN '{"evidence_refs":["SEED-DOC-1"]}'::jsonb
             ELSE jsonb_build_object('text', 'step ' || s) END,
      now(), now()
    FROM c CROSS JOIN generate_series(1, 400) AS s
  `)
  out(`history case: PERF-HISTORY-400 with 400 events (${elapsed()})\n`)

  await db.execute(sql`VACUUM ANALYZE cases`)
  await db.execute(sql`VACUUM ANALYZE case_events`)
  out(`vacuum analyze: done (${elapsed()})\n`)

  const summary = await db.execute<{ cases: number; status: string; tenant: string }>(sql`
    SELECT CASE WHEN tenant_id = ${BIG_TENANT}::uuid THEN 'acme' ELSE 'others' END AS tenant,
           status, count(*)::int AS cases
    FROM cases WHERE external_ref LIKE 'PERF-%' GROUP BY 1, 2 ORDER BY 1, 2`)
  for (const row of summary.rows) {
    out(`  ${row.tenant.padEnd(7)} ${row.status.padEnd(13)} ${String(row.cases)}\n`)
  }
  out(`done in ${elapsed()}. Explore it: export TOKEN=$(npm run -s dev:token)\n`)
} catch (error) {
  fail(`seed-perf failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await pool.end()
}
