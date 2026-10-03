import type { Pool, PoolClient } from 'pg'

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export interface AppliedMigration {
  appliedAt: Date
  checksum: string
  name: string
  version: string
}

export interface Migration {
  checksum: string
  name: string
  sql: string
  transactional: boolean
  version: string
}

export interface MigrationStatus {
  applied: AppliedMigration[]
  pending: Migration[]
}

export class MigrationError extends Error {
  override name = 'MigrationError'
}

// NNNN_name.sql for the hand-written 0001–0010; YYYYMMDDHHMMSS_name.sql for drizzle-kit output
// (migrations.prefix = 'timestamp'). Both sort correctly as strings.
const FILE_PATTERN = /^(\d{4}|\d{14})_([a-z0-9_]+)\.sql$/
const NO_TRANSACTION_MARKER = '-- migrate:no-transaction'

// A project-specific name, so the runner never adopts a `schema_migrations` table that
// belongs to another tool (golang-migrate, Rails, Flyway…) with a different shape.
const LEDGER = 'triple_migrations'
const ADVISORY_LOCK_KEY = 'triple:migrations'

// Transactional migrations take short, strong locks (ALTER TABLE…). If one has to wait, it
// queues, and every query behind it waits too. Failing after 5s and retrying is the safe
// choice against live traffic.
const TRANSACTIONAL_LOCK_TIMEOUT = '5s'

// CREATE INDEX CONCURRENTLY is different: its lock does not conflict with reads or writes,
// and it must wait for every transaction already open on the table. A short lock_timeout
// or a server-wide statement_timeout cancels it halfway and leaves an INVALID index, so it
// runs with both disabled. It can be slow; it does not block traffic.
const CONCURRENT_SETTINGS = ['SET lock_timeout = 0', 'SET statement_timeout = 0']
const CONCURRENT_RESET = ['RESET lock_timeout', 'RESET statement_timeout']

export async function loadMigrations(directory: string): Promise<Migration[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()
  const migrations: Migration[] = []
  const seen = new Set<string>()

  for (const file of files) {
    const match = FILE_PATTERN.exec(file)
    if (!match?.[1] || !match[2]) {
      throw new MigrationError(`${file}: expected NNNN_name.sql or YYYYMMDDHHMMSS_name.sql`)
    }

    const [, version, name] = match
    if (seen.has(version)) {
      throw new MigrationError(`${file}: duplicate version ${version}`)
    }
    seen.add(version)

    const sql = await readFile(path.join(directory, file), 'utf8')
    const transactional = !sql.trimStart().startsWith(NO_TRANSACTION_MARKER)

    // Several statements sent in one query run as an implicit transaction, which is exactly
    // what CREATE INDEX CONCURRENTLY refuses. One statement per file keeps it honest.
    if (!transactional && countStatements(sql) !== 1) {
      throw new MigrationError(
        `${file}: a no-transaction migration must hold exactly one statement`,
      )
    }

    migrations.push({ checksum: checksum(sql), name, sql, transactional, version })
  }

  return migrations
}

export function migrate(pool: Pool, migrations: Migration[]): Promise<Migration[]> {
  return withMigrationLock(pool, async (client) => {
    if (!(await ledgerExists(client))) {
      await assertDatabaseIsEmpty(client)
      await createLedger(client)
    }

    const applied = await readApplied(client)
    const pending = pendingMigrations(migrations, applied)

    for (const migration of pending) {
      await apply(client, migration)
    }

    return pending
  })
}

export function migrationStatus(pool: Pool, migrations: Migration[]): Promise<MigrationStatus> {
  return withMigrationLock(pool, async (client) => {
    const applied = (await ledgerExists(client)) ? await readApplied(client) : []
    return { applied, pending: pendingMigrations(migrations, applied) }
  })
}

async function apply(client: PoolClient, migration: Migration): Promise<void> {
  if (migration.transactional) {
    await applyInTransaction(client, migration)
  } else {
    await applyWithoutTransaction(client, migration)
  }
}

async function applyInTransaction(client: PoolClient, migration: Migration): Promise<void> {
  const started = performance.now()
  await client.query('BEGIN')
  try {
    await client.query(`SET LOCAL lock_timeout = '${TRANSACTIONAL_LOCK_TIMEOUT}'`)
    await client.query(migration.sql)
    await record(client, migration, started)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw wrap(migration, error)
  }
}

async function applyWithoutTransaction(client: PoolClient, migration: Migration): Promise<void> {
  const started = performance.now()
  const invalidBefore = new Set(await invalidIndexes(client))

  try {
    for (const statement of CONCURRENT_SETTINGS) await client.query(statement)
    await client.query(migration.sql)
    await record(client, migration, started)
  } catch (error) {
    // A failed CREATE INDEX CONCURRENTLY leaves an INVALID index behind. It is useless to
    // the planner, still maintained on every write, and it makes the retry fail with
    // "already exists". Only indexes this migration left behind are dropped; invalid
    // indexes that existed before are not ours to touch.
    const leftBehind = (await invalidIndexes(client)).filter((name) => !invalidBefore.has(name))
    for (const name of leftBehind) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`)
    }
    throw wrap(migration, error)
  } finally {
    for (const statement of CONCURRENT_RESET) await client.query(statement)
  }
}

// The runner only ever starts from an empty database. Pointed at a database that already
// has tables but no ledger (someone else's schema, a legacy system), applying migration 1..n
// would fail somewhere in the middle and leave it half-migrated. Refusing up front leaves it
// untouched.
async function assertDatabaseIsEmpty(client: PoolClient): Promise<void> {
  const result = await client.query<{ table_name: string }>(
    `SELECT schemaname || '.' || tablename AS table_name
     FROM pg_tables
     WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
     ORDER BY 1
     LIMIT 5`,
  )
  if (result.rows.length > 0) {
    const names = result.rows.map((row) => row.table_name).join(', ')
    throw new MigrationError(
      `refusing to migrate: the database has tables (${names}) but no ${LEDGER} ledger. ` +
        'These migrations create the schema from scratch; adopting an existing schema needs a ' +
        'dedicated baseline migration.',
    )
  }
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex')
}

function countStatements(sql: string): number {
  const withoutComments = sql.replace(/--.*$/gm, '')
  return withoutComments.split(';').filter((part) => part.trim().length > 0).length
}

async function createLedger(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE ${LEDGER} (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      transactional BOOLEAN NOT NULL,
      duration_ms INTEGER NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
}

async function invalidIndexes(client: PoolClient): Promise<string[]> {
  const result = await client.query<{ index_name: string }>(
    'SELECT indexrelid::regclass::text AS index_name FROM pg_index WHERE NOT indisvalid',
  )
  return result.rows.map((row) => row.index_name)
}

async function ledgerExists(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [LEDGER],
  )
  return result.rows[0]?.exists === true
}

function pendingMigrations(migrations: Migration[], applied: AppliedMigration[]): Migration[] {
  const known = new Map(migrations.map((migration) => [migration.version, migration]))

  for (const row of applied) {
    const file = known.get(row.version)
    if (!file) {
      throw new MigrationError(`${row.version}_${row.name}: applied but missing from disk`)
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(
        `${row.version}_${row.name}: edited after being applied. Fix forward in a new migration.`,
      )
    }
  }

  const done = new Set(applied.map((row) => row.version))
  return migrations.filter((migration) => !done.has(migration.version))
}

async function readApplied(client: PoolClient): Promise<AppliedMigration[]> {
  const result = await client.query<{
    applied_at: Date
    checksum: string
    name: string
    version: string
  }>(`SELECT version, name, checksum, applied_at FROM ${LEDGER} ORDER BY version`)

  return result.rows.map((row) => ({
    appliedAt: row.applied_at,
    checksum: row.checksum,
    name: row.name,
    version: row.version,
  }))
}

async function record(client: PoolClient, migration: Migration, started: number): Promise<void> {
  await client.query(
    `INSERT INTO ${LEDGER} (version, name, checksum, transactional, duration_ms)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      migration.version,
      migration.name,
      migration.checksum,
      migration.transactional,
      Math.round(performance.now() - started),
    ],
  )
}

// Two deploys starting at once must not apply the same migration twice. The advisory lock
// is held on one dedicated connection for the whole run.
async function withMigrationLock<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [ADVISORY_LOCK_KEY])
    try {
      return await work(client)
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [ADVISORY_LOCK_KEY])
    }
  } finally {
    client.release()
  }
}

function wrap(migration: Migration, error: unknown): MigrationError {
  if (error instanceof MigrationError) return error
  const reason = error instanceof Error ? error.message : String(error)
  return new MigrationError(`${migration.version}_${migration.name}: ${reason}`, { cause: error })
}
