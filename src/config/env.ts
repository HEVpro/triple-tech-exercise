import { z } from 'zod'

// The application's runtime configuration. The migration and seed scripts use their own owner
// connection (MIGRATION_DATABASE_URL) and do not read this.
const schema = z
  .object({
    // Only locally minted HS256 tokens exist today (D-12). The setting is explicit so that a
    // production deployment has to change it, and the refinement below refuses to start if not.
    AUTH_MODE: z.literal('dev').default('dev'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(500).default(10),
    DATABASE_SSL: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    // The API connects as a login role that is a member of triple_app: it can read and append,
    // never update or delete events (migrations 0001, 0005, 0006).
    DATABASE_URL: z.url(),
    JWT_AUDIENCE: z.string().min(1),
    JWT_ISSUER: z.string().min(1),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
  })
  // The only auth mode mints its own tokens, so there is no safe production configuration yet.
  // Adding a real mode (OIDC) is what lifts this.
  .refine((config) => config.NODE_ENV !== 'production', {
    message: 'AUTH_MODE=dev mints its own tokens and is refused when NODE_ENV=production',
    path: ['AUTH_MODE'],
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
