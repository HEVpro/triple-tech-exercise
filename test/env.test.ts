import { afterEach, describe, expect, it } from 'vitest'

import { apiEnv, resetEnvCache, runtimeEnv } from '../src/config/env.js'

afterEach(() => {
  resetEnvCache()
})

function withEnv(overrides: Record<string, string>, check: () => void): void {
  const previous = Object.fromEntries(Object.keys(overrides).map((k) => [k, process.env[k]]))
  Object.assign(process.env, overrides)
  try {
    check()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }
}

describe('API configuration', () => {
  it('parses a complete environment and applies defaults', () => {
    expect(apiEnv()).toMatchObject({
      AUTH_MODE: 'dev',
      DATABASE_POOL_MAX: 10,
      DATABASE_SSL: false,
      PORT: 3000,
      SWEEP_INTERVAL_MS: 60_000,
    })
  })

  it('rejects a database url that is not a url', () => {
    withEnv({ DATABASE_URL: 'not-a-url' }, () => {
      expect(() => apiEnv()).toThrow()
    })
  })

  it('rejects an unknown log level', () => {
    withEnv({ LOG_LEVEL: 'verbose' }, () => {
      expect(() => apiEnv()).toThrow()
    })
  })

  it('coerces a numeric string sweep interval', () => {
    withEnv({ SWEEP_INTERVAL_MS: '1500' }, () => {
      expect(apiEnv().SWEEP_INTERVAL_MS).toBe(1500)
    })
  })

  it('rejects a short JWT secret', () => {
    withEnv({ JWT_SECRET: 'too-short' }, () => {
      expect(() => apiEnv()).toThrow(/at least 32 characters/)
    })
  })

  it('refuses to start with dev auth in production', () => {
    withEnv({ NODE_ENV: 'production' }, () => {
      expect(() => apiEnv()).toThrow(/refused when NODE_ENV=production/)
    })
  })
})

describe('runtime configuration (what the sweeper reads)', () => {
  it('needs no authentication settings', () => {
    withEnv({ JWT_AUDIENCE: '', JWT_ISSUER: '', JWT_SECRET: '' }, () => {
      expect(runtimeEnv()).toMatchObject({ SWEEP_INTERVAL_MS: 60_000 })
    })
  })

  it('starts in production, where the dev-only API refuses to', () => {
    withEnv({ NODE_ENV: 'production' }, () => {
      expect(runtimeEnv().NODE_ENV).toBe('production')
      expect(() => apiEnv()).toThrow(/refused when NODE_ENV=production/)
    })
  })
})
