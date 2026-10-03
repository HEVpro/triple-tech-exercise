import { z } from 'zod'

const schema = z.object({
  AUTH_MODE: z.enum(['dev', 'oidc']).default('dev'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(500).default(10),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  DATABASE_URL: z.url(),
  JWT_AUDIENCE: z.string().min(1),
  JWT_ISSUER: z.url(),

  JWT_JWKS_URL: z.url(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),

  SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),

  TENANT_BASE_CURRENCY: z.string().length(3),
  TENANT_ID: z.uuid(),
  TENANT_NAME: z.string().min(1),
  TENANT_TIMEZONE: z.string().min(1),
})

export type Env = z.infer<typeof schema>

let cached: Env | undefined

export function env(): Env {
  cached ??= schema.parse(process.env)
  return cached
}

export function resetEnvCache(): void {
  cached = undefined
}
