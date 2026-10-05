import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { z } from 'zod'

import { tenantRuleConfig, tenants } from '../src/infrastructure/db/schema/index.js'
import { DEV_RULE_ORDER, DEV_TENANTS } from './dev-tenants.js'

// Development data. Never run against production: it creates a login role with the password
// from DATABASE_URL and two demo tenants. Idempotent: running it twice changes nothing.
//
// 1. The API's login role, taken from DATABASE_URL (user and password), as a member of
//    triple_app. Roles are cluster-wide, so this needs the owner connection.
// 2. The two demo tenants.
// 3. Globex's rule order, so the per-tenant configuration can be seen working.

const out = process.stdout.write.bind(process.stdout)
const fail = process.stderr.write.bind(process.stderr)

const config = z
  .object({ DATABASE_URL: z.url(), MIGRATION_DATABASE_URL: z.url() })
  .safeParse(process.env)

if (!config.success) {
  fail('dev-seed needs DATABASE_URL (the API role) and MIGRATION_DATABASE_URL (the owner)\n')
  process.exit(2)
}

const apiRole = new URL(config.data.DATABASE_URL)
const role = decodeURIComponent(apiRole.username)
const password = decodeURIComponent(apiRole.password)

if (!/^[a-z_][a-z0-9_]*$/.test(role) || password.length === 0) {
  fail('DATABASE_URL must name a simple role (a-z, 0-9, _) and include its password\n')
  process.exit(2)
}

const pool = new Pool({ connectionString: config.data.MIGRATION_DATABASE_URL })
const db = drizzle({ client: pool })

try {
  // CREATE ROLE cannot take bind parameters, and a DO block is a literal, so PostgreSQL's own
  // format() builds the statement from bound values, quoting the name (%I) and password (%L).
  const existing = await db.execute(sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`)
  if (existing.rows.length === 0) {
    const statement = await db.execute<{ ddl: string }>(
      sql`SELECT format('CREATE ROLE %I LOGIN PASSWORD %L IN ROLE triple_app', ${role}::text, ${password}::text) AS ddl`,
    )
    const ddl = statement.rows[0]?.ddl
    if (!ddl) throw new Error('could not build CREATE ROLE')
    await db.execute(sql.raw(ddl))
  }
  out(`role ${role}: ready (member of triple_app)\n`)

  const inserted = await db
    .insert(tenants)
    .values(Object.values(DEV_TENANTS))
    .onConflictDoNothing()
    .returning({ id: tenants.id })
  out(
    `tenants: ${inserted.length} created, ${Object.keys(DEV_TENANTS).length - inserted.length} already present\n`,
  )

  const ordered = await db
    .insert(tenantRuleConfig)
    .values([...DEV_RULE_ORDER])
    .onConflictDoNothing()
    .returning({ rule_key: tenantRuleConfig.rule_key })
  out(
    `rule order: globex evaluates scheme_outcome first (${ordered.length === 0 ? 'already set' : 'set'})\n`,
  )
} catch (error) {
  fail(`dev-seed failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await pool.end()
}
