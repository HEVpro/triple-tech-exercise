import { z } from 'zod'

// Configuration, in two parts, so each process receives only what it uses.
//
//   runtimeEnv()  what every process needs: database, logging, the sweep interval. The deadline
//                 sweeper reads only this, so it needs no JWT secret and can run in production.
//   apiEnv()      runtimeEnv() plus the HTTP API's own settings: port and authentication.
//
// The migration and seed scripts use their own owner connection (MIGRATION_DATABASE_URL) and read
// neither.

const runtimeSchema = z.object({
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(500).default(10),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  // A login role that is a member of triple_app: it can read and append, never update or delete
  // events (migrations 0001, 0005, 0006).
  DATABASE_URL: z.url(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']),
  SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
})

const apiSchema = runtimeSchema
  .extend({
    // Only locally minted HS256 tokens exist today (D-12). The setting is explicit so that a
    // production deployment has to change it, and the refinement below refuses to start if not.
    AUTH_MODE: z.literal('dev').default('dev'),
    JWT_AUDIENCE: z.string().min(1),
    JWT_ISSUER: z.string().min(1),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  })
  // The only auth mode mints its own tokens, so there is no safe production configuration for the
  // API yet. Adding a real mode (OIDC) is what lifts this. It applies to the API only.
  .refine((config) => config.NODE_ENV !== 'production', {
    message: 'AUTH_MODE=dev mints its own tokens and is refused when NODE_ENV=production',
    path: ['AUTH_MODE'],
  })

export type ApiEnv = z.infer<typeof apiSchema>
export type RuntimeEnv = z.infer<typeof runtimeSchema>

let api: ApiEnv | undefined
let runtime: RuntimeEnv | undefined

export function apiEnv(): ApiEnv {
  api ??= apiSchema.parse(process.env)
  return api
}

export function resetEnvCache(): void {
  api = undefined
  runtime = undefined
}

export function runtimeEnv(): RuntimeEnv {
  runtime ??= runtimeSchema.parse(process.env)
  return runtime
}
