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

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/
const NO_TRANSACTION_MARKER = '-- migrate:no-transaction'
const ADVISORY_LOCK_KEY = 'triple:schema_migrations'

// A migration that waits longer than this for a lock fails instead of queueing. A queued
// ALTER TABLE blocks every query behind it, so failing fast and retrying is the safe choice
// against live traffic.
const LOCK_TIMEOUT = '5s'

export async function loadMigrations(directory: string): Promise<Migration[]> {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()
  const migrations: Migration[] = []
  const seen = new Set<string>()

  for (const file of files) {
    const match = FILE_PATTERN.exec(file)
    if (!match?.[1] || !match[2]) {
      throw new MigrationError(`${file}: expected NNNN_snake_case.sql`)
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
    const applied = await readApplied(client)
    return { applied, pending: pendingMigrations(migrations, applied) }
  })
}

async function apply(client: PoolClient, migration: Migration): Promise<void> {
  const started = performance.now()

  if (migration.transactional) {
    await client.query('BEGIN')
    try {
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
      await client.query(migration.sql)
      await record(client, migration, started)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw wrap(migration, error)
    }
    return
  }

  try {
    await client.query(`SET lock_timeout = '${LOCK_TIMEOUT}'`)
    await client.query(migration.sql)
    await assertNoInvalidIndexes(client)
    await record(client, migration, started)
  } catch (error) {
    throw wrap(migration, error)
  } finally {
    await client.query('RESET lock_timeout')
  }
}

// A failed CREATE INDEX CONCURRENTLY leaves an INVALID index behind. It is ignored by the
// planner but still maintained on every write, and IF NOT EXISTS would silently skip it on
// a retry, so it is surfaced here instead.
async function assertNoInvalidIndexes(client: PoolClient): Promise<void> {
  const result = await client.query<{ index_name: string }>(
    'SELECT indexrelid::regclass::text AS index_name FROM pg_index WHERE NOT indisvalid',
  )
  if (result.rows.length > 0) {
    const names = result.rows.map((row) => row.index_name).join(', ')
    throw new MigrationError(`invalid indexes left behind: ${names}. Drop them and re-run.`)
  }
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex')
}

function countStatements(sql: string): number {
  const withoutComments = sql.replace(/--.*$/gm, '')
  return withoutComments.split(';').filter((part) => part.trim().length > 0).length
}

async function ensureLedger(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      transactional BOOLEAN NOT NULL,
      duration_ms INTEGER NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
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
  }>('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')

  return result.rows.map((row) => ({
    appliedAt: row.applied_at,
    checksum: row.checksum,
    name: row.name,
    version: row.version,
  }))
}

async function record(client: PoolClient, migration: Migration, started: number): Promise<void> {
  await client.query(
    `INSERT INTO schema_migrations (version, name, checksum, transactional, duration_ms)
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
      await ensureLedger(client)
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
