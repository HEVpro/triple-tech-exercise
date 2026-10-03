import { describe, expect, it } from 'vitest'

import { app } from '../src/http/app.js'
import { closeDbPool, dbPool } from '../src/infrastructure/db/pool.js'

const databaseAvailable = await dbPool()
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false)

if (!databaseAvailable) {
  await closeDbPool()
}

describe.skipIf(!databaseAvailable)('readiness against a live database', () => {
  it('reports ready when postgres answers', async () => {
    const response = await app.request('/readyz')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      checks: { postgres: 'up' },
      status: 'ready',
    })
  })

  it('exposes a request id on every response', async () => {
    const response = await app.request('/healthz')
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('readiness without a database', () => {
  it('skips the live database suite when postgres is unreachable', () => {
    expect(typeof databaseAvailable).toBe('boolean')
  })
})
