import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { z } from 'zod'

import { caseHistory, stuckQueue } from '../src/application/cases/index.js'
import { postgresCaseStore } from '../src/infrastructure/db/case-store.js'
import * as schema from '../src/infrastructure/db/schema/index.js'
import { DEV_TENANTS } from './dev-tenants.js'

// Query plans for the queries the review scenarios measure, against the data `npm run seed:perf`
// put in the development database. The SQL is not written here: the real use cases run through the
// real Drizzle adapter, Drizzle's logger captures every statement, and each relevant one is
// re-run under EXPLAIN (ANALYZE, BUFFERS) with the same parameters.
//
//   npm run perf:explain

const out = process.stdout.write.bind(process.stdout)
const fail = process.stderr.write.bind(process.stderr)

const BIG_TENANT = DEV_TENANTS.acme.id

const ownerUrl = z.url().safeParse(process.env['MIGRATION_DATABASE_URL'])
if (!ownerUrl.success) {
  fail('usage: npm run perf:explain  (needs MIGRATION_DATABASE_URL)\n')
  process.exit(2)
}

const pool = new Pool({ connectionString: ownerUrl.data, max: 2 })

const captured: { params: unknown[]; sql: string }[] = []
const db = drizzle({
  client: pool,
  logger: { logQuery: (sql, params) => captured.push({ params, sql }) },
  schema,
})
const store = postgresCaseStore(db)
const principal = { actor: { id: 'perf', type: 'human' as const }, tenantId: BIG_TENANT }

// Re-runs the captured statements that match, under EXPLAIN (ANALYZE, BUFFERS).
async function explain(label: string, match: (sql: string) => boolean): Promise<void> {
  for (const statement of captured.filter((candidate) => match(candidate.sql))) {
    const plan = await pool.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS) ${statement.sql}`,
      statement.params,
    )
    out(`\n=== ${label}\n`)
    for (const row of plan.rows) out(`${row['QUERY PLAN']}\n`)
  }
}

const queuePage = { limit: 50, riskWindowDays: 7, states: ['at_risk', 'breached'] as const }

try {
  const cases = await pool.query<{ count: string }>('SELECT count(*) FROM cases')
  out(`${cases.rows[0]?.count ?? '0'} cases; explaining for Acme (${BIG_TENANT})\n`)

  captured.length = 0
  const first = await stuckQueue(store, principal, { ...queuePage, after: null })
  await explain('stuck queue: first page (scenario 4)', (sql) => sql.includes('union all'))
  await explain('stuck queue: summary', (sql) => sql.includes('filter (where'))

  captured.length = 0
  await stuckQueue(store, principal, { ...queuePage, after: first.next })
  await explain('stuck queue: second page (keyset)', (sql) => sql.includes('union all'))

  const history = await pool.query<{ id: string }>(
    `SELECT id FROM cases WHERE external_ref = 'PERF-HISTORY-400'`,
  )
  const historyId = history.rows[0]?.id
  if (historyId) {
    captured.length = 0
    await caseHistory(store, principal, historyId, null)
    await explain('case history, 400 events (scenario 3)', (sql) => sql.includes('"case_events"'))
  }
} catch (error) {
  fail(`perf-explain failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await pool.end()
}
