import { afterEach, describe, expect, it } from 'vitest'

import { env, resetEnvCache } from '../src/config/env.js'

afterEach(() => {
  resetEnvCache()
})

describe('env schema', () => {
  it('parses a complete environment and applies defaults', () => {
    expect(env()).toMatchObject({
      DATABASE_POOL_MAX: 10,
      DATABASE_SSL: false,
      PORT: 3000,
      SWEEP_INTERVAL_MS: 60_000,
      TENANT_BASE_CURRENCY: 'EUR',
    })
  })

  it('rejects a database url that is not a url', () => {
    const previous = process.env['DATABASE_URL']
    process.env['DATABASE_URL'] = 'not-a-url'
    expect(() => env()).toThrow()
    process.env['DATABASE_URL'] = previous
  })

  it('rejects an unknown log level', () => {
    const previous = process.env['LOG_LEVEL']
    process.env['LOG_LEVEL'] = 'verbose'
    expect(() => env()).toThrow()
    process.env['LOG_LEVEL'] = previous
  })

  it('coerces a numeric string sweep interval', () => {
    const previous = process.env['SWEEP_INTERVAL_MS']
    process.env['SWEEP_INTERVAL_MS'] = '1500'
    expect(env().SWEEP_INTERVAL_MS).toBe(1500)
    process.env['SWEEP_INTERVAL_MS'] = previous
  })
})
