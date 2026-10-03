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
      DATABASE_SSL: 'false',
      DATABASE_URL: 'postgres://triple_api:triple_api@localhost:5433/triple',
      JWT_AUDIENCE: 'triple-dispute-api',
      JWT_ISSUER: 'triple-dev',
      JWT_SECRET: 'test-only-secret-0123456789abcdefghijklmnop',
      LOG_LEVEL: 'silent',
      MIGRATION_DATABASE_URL: 'postgres://triple:triple@localhost:5433/triple',
      NODE_ENV: 'test',
    },
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.ts'],
  },
})
