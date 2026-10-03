import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      exclude: ['src/index.ts', 'test/**'],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: {
        branches: 60,
        functions: 80,
        lines: 85,
        // The business rules are the part a regulator audits; they are held to a higher bar.
        'src/domain/**': {
          branches: 95,
          functions: 100,
          lines: 100,
          // One defensive throw in deadline.ts cannot be reached without mocking Intl.
          statements: 99,
        },
        statements: 85,
      },
    },
    env: {
      AUTH_MODE: 'dev',
      DATABASE_SSL: 'false',
      DATABASE_URL: 'postgres://triple:triple@localhost:5433/triple',
      JWT_AUDIENCE: 'triple-dispute-api',
      JWT_ISSUER: 'https://auth.triple.local',
      JWT_JWKS_URL: 'http://localhost:3000/dev/jwks',
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
      TENANT_BASE_CURRENCY: 'EUR',
      TENANT_ID: '11111111-1111-4111-8111-111111111111',
      TENANT_NAME: 'Acme Issuer',
      TENANT_TIMEZONE: 'Europe/Madrid',
    },
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.ts'],
  },
})
