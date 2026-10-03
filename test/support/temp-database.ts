import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'

const adminUrl = process.env['DATABASE_URL'] ?? 'postgres://triple:triple@localhost:5433/triple'

export interface TempDatabase {
  drop: () => Promise<void>
  pool: Pool
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
    drop: async () => {
      await pool.end()
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await admin.end()
    },
    pool,
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
