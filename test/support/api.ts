import { drizzle } from 'drizzle-orm/node-postgres'
import { sign } from 'hono/jwt'
import { DatabaseError, Pool } from 'pg'

import type { CaseStore } from '../../src/application/cases/index.js'

import { DEV_TENANTS, type DevTenantSlug } from '../../scripts/dev-tenants.js'
import { createApp } from '../../src/http/app.js'
import { postgresCaseStore } from '../../src/infrastructure/db/case-store.js'
import { loadMigrations, migrate } from '../../src/infrastructure/db/migrator.js'
import * as schema from '../../src/infrastructure/db/schema/index.js'
import { createTempDatabase } from './temp-database.js'

export const AUTH = {
  audience: 'triple-dispute-api',
  issuer: 'triple-dev',
  secret: 'test-only-secret-0123456789abcdefghijklmnop',
}

const API_ROLE = { name: 'triple_api', password: 'triple_api' }

export interface TestApi {
  app: ReturnType<typeof createApp>
  drop: () => Promise<void>
  // As the schema owner, for assertions the API itself is not allowed to make.
  owner: Pool
  request: (
    method: string,
    path: string,
    options?: { body?: unknown; headers?: Record<string, string>; token?: null | string },
  ) => Promise<{ body: Record<string, unknown>; status: number }>
  // The same store the API uses, connected as triple_api: for use cases outside HTTP (the sweeper).
  store: CaseStore
  token: (tenant?: DevTenantSlug, claims?: Record<string, unknown>) => Promise<string>
}

// A throwaway database, migrated and seeded with the demo tenants, and the API connected to it
// as triple_api: the same restricted role it uses for real, so privilege mistakes fail here.
export async function startApi(): Promise<TestApi> {
  const temp = await createTempDatabase()
  await migrate(temp.pool, await loadMigrations('migrations'))
  await ensureApiRole(temp.pool)
  await drizzle({ client: temp.pool }).insert(schema.tenants).values(Object.values(DEV_TENANTS))

  const url = new URL(temp.url)
  url.username = API_ROLE.name
  url.password = API_ROLE.password
  const apiPool = new Pool({ connectionString: url.toString(), max: 4 })

  const store = postgresCaseStore(drizzle({ client: apiPool, schema }))
  const app = createApp({
    auth: AUTH,
    caseStore: store,
    ping: () => apiPool.query('SELECT 1'),
  })

  const token = (tenant: DevTenantSlug = 'acme', claims: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000)
    return sign(
      {
        actor_type: 'human',
        aud: AUTH.audience,
        exp: now + 600,
        iat: now,
        iss: AUTH.issuer,
        sub: `${tenant}-analyst`,
        tenant_id: DEV_TENANTS[tenant].id,
        ...claims,
      },
      AUTH.secret,
      'HS256',
    )
  }

  const defaultToken = await token()

  return {
    app,
    drop: async () => {
      await apiPool.end()
      await temp.drop()
    },
    owner: temp.pool,
    request: async (method, path, options = {}) => {
      const headers: Record<string, string> = { ...options.headers }
      const bearer = options.token === undefined ? defaultToken : options.token
      if (bearer !== null) headers['authorization'] = `Bearer ${bearer}`
      if (options.body !== undefined) headers['content-type'] = 'application/json'
      const response = await app.request(path, {
        headers,
        method,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      })
      return { body: (await response.json()) as Record<string, unknown>, status: response.status }
    },
    store,
    token,
  }
}

// Roles are cluster-wide and the suites run in parallel, each in its own database: several can
// find the role missing and try to create it at once. PostgreSQL then fails the losers in one of
// two ways, depending on how far the winner got: "role already exists" (42710) or, when both
// insert into the catalogue at the same instant, a unique violation on it (23505). Both mean the
// role is there.
const ROLE_ALREADY_CREATED = new Set(['23505', '42710'])

async function ensureApiRole(owner: Pool): Promise<void> {
  const existing = await owner.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [API_ROLE.name])
  if (existing.rowCount !== 0) return

  await owner
    .query(`CREATE ROLE ${API_ROLE.name} LOGIN PASSWORD '${API_ROLE.password}' IN ROLE triple_app`)
    .catch((error: unknown) => {
      if (!(error instanceof DatabaseError && ROLE_ALREADY_CREATED.has(error.code ?? ''))) {
        throw error
      }
    })
}
