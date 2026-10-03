import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import { env } from '../../config/env.js'
import { logger } from '../../logger.js'

let pool: Pool | undefined
let db: ReturnType<typeof drizzle> | undefined

export async function closeDbPool(): Promise<void> {
  if (!pool) return
  await pool.end()
  pool = undefined
  db = undefined
}

export function database(): ReturnType<typeof drizzle> {
  db ??= drizzle({ casing: 'snake_case', client: dbPool() })
  return db
}

export function dbPool(): Pool {
  pool ??= new Pool({
    application_name: 'triple-dispute-api',
    connectionString: env().DATABASE_URL,
    idleTimeoutMillis: 30_000,
    max: env().DATABASE_POOL_MAX,
    ssl: env().DATABASE_SSL ? { rejectUnauthorized: false } : false,
  })

  pool.on('error', (error: Error) => {
    logger().error({ err: error }, 'idle database client error')
  })

  return pool
}
