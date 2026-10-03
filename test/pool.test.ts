import { afterEach, describe, expect, it } from 'vitest'

import { closeDbPool, database, dbPool } from '../src/infrastructure/db/pool.js'

afterEach(async () => {
  await closeDbPool()
})

describe('database pool lifecycle', () => {
  it('reuses the same pool instance across calls', () => {
    expect(dbPool()).toBe(dbPool())
  })

  it('reuses the same drizzle instance across calls', () => {
    expect(database()).toBe(database())
  })

  it('is safe to close a pool that was never created', async () => {
    await closeDbPool()
    await expect(closeDbPool()).resolves.toBeUndefined()
  })

  it('rebuilds the pool after a close', async () => {
    const first = dbPool()
    await closeDbPool()
    expect(dbPool()).not.toBe(first)
  })
})
