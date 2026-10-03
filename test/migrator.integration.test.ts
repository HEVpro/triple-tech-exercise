import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  loadMigrations,
  migrate,
  type Migration,
  migrationStatus,
} from '../src/infrastructure/db/migrator.js'
import {
  createTempDatabase,
  databaseAvailable,
  type TempDatabase,
} from './support/temp-database.js'

const available = await databaseAvailable()
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function freshDatabase(): Promise<TempDatabase> {
  const temp = await createTempDatabase()
  cleanups.push(temp.drop)
  return temp
}

async function invalidIndexes(temp: TempDatabase): Promise<string[]> {
  const result = await temp.pool.query<{ name: string }>(
    'SELECT indexrelid::regclass::text AS name FROM pg_index WHERE NOT indisvalid ORDER BY 1',
  )
  return result.rows.map((row) => row.name)
}

async function migrationsFrom(files: Record<string, string>): Promise<Migration[]> {
  const directory = await mkdtemp(path.join(tmpdir(), 'triple-migrations-'))
  cleanups.push(() => rm(directory, { force: true, recursive: true }))
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(path.join(directory, name), sql)
  }
  return loadMigrations(directory)
}

const TABLE_WITH_DUPLICATES = 'CREATE TABLE t (id INT); INSERT INTO t VALUES (1), (1);'
const UNIQUE_INDEX =
  '-- migrate:no-transaction\nCREATE UNIQUE INDEX CONCURRENTLY t_id_key ON t (id);'

describe.skipIf(!available)('migrating a database that is not ours', () => {
  it('refuses a database that already has tables, and leaves it untouched', async () => {
    const temp = await freshDatabase()
    await temp.pool.query('CREATE TABLE cases (id UUID PRIMARY KEY, amount_cents BIGINT)')
    await temp.pool.query(
      'CREATE TABLE schema_migrations (version BIGINT PRIMARY KEY, dirty BOOLEAN NOT NULL)',
    )

    await expect(migrate(temp.pool, await loadMigrations('migrations'))).rejects.toThrow(
      /refusing to migrate: the database has tables/,
    )

    const created = await temp.pool.query(
      `SELECT to_regclass('triple_migrations') AS ledger, to_regclass('tenants') AS tenants`,
    )
    expect(created.rows[0]).toEqual({ ledger: null, tenants: null })
  })

  it('reports status without creating the ledger', async () => {
    const temp = await freshDatabase()
    const migrations = await loadMigrations('migrations')

    const status = await migrationStatus(temp.pool, migrations)

    expect(status.pending).toHaveLength(migrations.length)
    const ledger = await temp.pool.query(`SELECT to_regclass('triple_migrations') AS ledger`)
    expect(ledger.rows[0]).toEqual({ ledger: null })
  })
})

describe.skipIf(!available)('concurrent index builds', () => {
  it('drops the invalid index a failed build leaves, so the retry can succeed', async () => {
    const temp = await freshDatabase()
    const migrations = await migrationsFrom({
      '0001_table.sql': TABLE_WITH_DUPLICATES,
      '0002_unique.sql': UNIQUE_INDEX,
    })

    await expect(migrate(temp.pool, migrations)).rejects.toThrow(
      /0002_unique: could not create unique index/,
    )
    expect(await invalidIndexes(temp)).toEqual([])

    await temp.pool.query('DELETE FROM t WHERE ctid = (SELECT max(ctid) FROM t)')
    await expect(migrate(temp.pool, migrations)).resolves.toHaveLength(1)
    expect(await invalidIndexes(temp)).toEqual([])
  })

  it('ignores invalid indexes that existed before the migration', async () => {
    const temp = await freshDatabase()
    const first = await migrationsFrom({ '0001_table.sql': TABLE_WITH_DUPLICATES })
    await migrate(temp.pool, first)
    await expect(
      temp.pool.query('CREATE UNIQUE INDEX CONCURRENTLY someone_elses_key ON t (id)'),
    ).rejects.toThrow()
    expect(await invalidIndexes(temp)).toEqual(['someone_elses_key'])

    const both = await migrationsFrom({
      '0001_table.sql': TABLE_WITH_DUPLICATES,
      '0002_index.sql': '-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY t_id_idx ON t (id);',
    })

    await expect(migrate(temp.pool, both)).resolves.toHaveLength(1)
    expect(await invalidIndexes(temp)).toEqual(['someone_elses_key'])
  })

  it('waits for a long-running transaction instead of failing on lock_timeout', async () => {
    const temp = await freshDatabase()
    const migrations = await migrationsFrom({
      '0001_table.sql': 'CREATE TABLE t (id INT);',
      '0002_index.sql': '-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY t_id_idx ON t (id);',
    })
    await migrate(temp.pool, migrations.slice(0, 1))

    // A transaction holding a snapshot on t for longer than any lock_timeout we would set
    // on a transactional migration. CREATE INDEX CONCURRENTLY has to wait for it.
    const reader = await temp.pool.connect()
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    await reader.query('SELECT count(*) FROM t')
    const finishReader = new Promise<void>((resolve) => {
      setTimeout(() => {
        void reader
          .query('COMMIT')
          .finally(() => {
            reader.release()
          })
          .then(() => {
            resolve()
          })
      }, 6_000)
    })

    const started = Date.now()
    await expect(migrate(temp.pool, migrations)).resolves.toHaveLength(1)
    await finishReader
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_000)
    expect(await invalidIndexes(temp)).toEqual([])
  }, 20_000)
})

describe('migrator integration suite without a database', () => {
  it('skips itself when postgres is unreachable', () => {
    expect(typeof available).toBe('boolean')
  })
})
