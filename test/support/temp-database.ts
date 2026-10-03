import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'

// Throwaway databases are created and migrated as the schema owner.
const adminUrl =
  process.env['MIGRATION_DATABASE_URL'] ?? 'postgres://triple:triple@localhost:5433/triple'

export interface TempDatabase {
  drop: () => Promise<void>
  pool: Pool
  // Owner connection string of the throwaway database.
  url: string
}

// Every suite gets its own throwaway database, so migration tests always start from empty
// and never touch the developer's data.
export async function createTempDatabase(): Promise<TempDatabase> {
  const name = `triple_test_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: adminUrl, max: 1 })
  await admin.query(`CREATE DATABASE ${name}`)

  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const pool = new Pool({ connectionString: url.toString(), max: 4 })

  return {
    // Callers end their own pools first. pg-pool resolves end() as soon as its clients are
    // detached, before their sockets have closed, so the database is dropped only once
    // PostgreSQL reports no session left on it. Forcing the drop earlier terminates those
    // closing sessions, and the FATAL reaches a client with no listener: an uncaught error that
    // fails the run even though every test passed.
    drop: async () => {
      await pool.end()
      await waitUntilNoSessions(admin, name)
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await admin.end()
    },
    pool,
    url: url.toString(),
  }
}

export async function databaseAvailable(): Promise<boolean> {
  const probe = new Pool({ connectionString: adminUrl, connectionTimeoutMillis: 2_000 })
  try {
    await probe.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await probe.end()
  }
}

async function waitUntilNoSessions(admin: Pool, database: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await admin.query<{ sessions: number }>(
      'SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE datname = $1',
      [database],
    )
    if (result.rows[0]?.sessions === 0) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
