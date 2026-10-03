import type { Pool } from 'pg'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadMigrations, migrate } from '../src/infrastructure/db/migrator.js'
import * as schema from '../src/infrastructure/db/schema/index.js'
import { sqlForSchema } from './support/drizzle-sql.js'
import {
  createTempDatabase,
  databaseAvailable,
  type TempDatabase,
} from './support/temp-database.js'

// The TypeScript schema (what Drizzle queries and drizzle-kit diffs against) must describe the
// database the migrations actually build. Two databases are built side by side: one by the
// migration runner, one from the SQL drizzle-kit generates for the TypeScript schema. Their
// catalogues must match, except for the objects drizzle-kit cannot express, which live in custom
// migrations only.
const MANAGED_BY_CUSTOM_MIGRATIONS = new Set([
  'cases_at_risk_idx',
  'cases_breached_idx',
  'cases_sweep_idx',
])

const available = await databaseAvailable()

let fromMigrations: TempDatabase
let fromDrizzle: TempDatabase

beforeAll(async () => {
  if (!available) return
  fromMigrations = await createTempDatabase()
  fromDrizzle = await createTempDatabase()

  await migrate(fromMigrations.pool, await loadMigrations('migrations'))

  for (const statement of await sqlForSchema(schema)) await fromDrizzle.pool.query(statement)
})

afterAll(async () => {
  if (!available) return
  await fromMigrations.drop()
  await fromDrizzle.drop()
})

async function columns(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ line: string }>(`
    SELECT concat_ws(' | ', table_name, column_name, data_type, is_nullable,
             coalesce(column_default, '-'), coalesce(character_maximum_length::text, '-'),
             coalesce(numeric_precision::text, '-'), coalesce(numeric_scale::text, '-'),
             is_identity) AS line
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name <> 'triple_migrations'
    ORDER BY table_name, column_name`)
  return result.rows.map((row) => row.line)
}

async function constraints(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ line: string }>(`
    SELECT concat_ws(' | ', rel.relname, con.conname, pg_get_constraintdef(con.oid)) AS line
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE ns.nspname = 'public' AND rel.relname <> 'triple_migrations'
    ORDER BY rel.relname, con.conname`)
  return result.rows.map((row) => row.line)
}

async function indexes(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ indexdef: string; indexname: string }>(`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename <> 'triple_migrations'
    ORDER BY indexname`)
  return result.rows
    .filter((row) => !MANAGED_BY_CUSTOM_MIGRATIONS.has(row.indexname))
    .map((row) => row.indexdef)
}

describe.skipIf(!available)('the Drizzle schema matches the migrated database', () => {
  it('has the same columns, types, nullability and defaults', async () => {
    expect(await columns(fromDrizzle.pool)).toEqual(await columns(fromMigrations.pool))
  })

  it('has the same constraints, with the same names and definitions', async () => {
    expect(await constraints(fromDrizzle.pool)).toEqual(await constraints(fromMigrations.pool))
  })

  it('has the same indexes, apart from those written as custom migrations', async () => {
    expect(await indexes(fromDrizzle.pool)).toEqual(await indexes(fromMigrations.pool))
  })
})

describe('schema drift suite without a database', () => {
  it('skips itself when postgres is unreachable', () => {
    expect(typeof available).toBe('boolean')
  })
})
