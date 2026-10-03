import { sign } from 'hono/jwt'
import { parseArgs } from 'node:util'
import { z } from 'zod'

import { DEV_TENANTS, type DevTenantSlug } from './dev-tenants.js'

// Mints a development token, signed with JWT_SECRET, for one of the demo tenants. A CLI rather
// than an HTTP endpoint on purpose: the API has no route that issues tokens (D-12).
//
//   npm run dev:token                          # acme, human
//   npm run dev:token -- --tenant globex --actor agent --ttl 30

const out = process.stdout.write.bind(process.stdout)
const fail = process.stderr.write.bind(process.stderr)

const { values } = parseArgs({
  options: {
    actor: { default: 'human', type: 'string' },
    sub: { type: 'string' },
    tenant: { default: 'acme', type: 'string' },
    ttl: { default: '60', type: 'string' },
  },
})

const args = z
  .object({
    actor: z.enum(['human', 'agent']),
    sub: z.string().min(1).optional(),
    tenant: z.enum(Object.keys(DEV_TENANTS) as [DevTenantSlug, ...DevTenantSlug[]]),
    ttl: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 60),
  })
  .safeParse(values)

const config = z
  .object({
    JWT_AUDIENCE: z.string().min(1),
    JWT_ISSUER: z.string().min(1),
    JWT_SECRET: z.string().min(32),
  })
  .safeParse(process.env)

if (!args.success || !config.success) {
  fail(
    'usage: npm run dev:token -- [--tenant acme|globex] [--actor human|agent] [--sub id] [--ttl minutes]\n',
  )
  fail('needs JWT_SECRET, JWT_ISSUER and JWT_AUDIENCE (see .env.example)\n')
  process.exit(2)
}

const now = Math.floor(Date.now() / 1000)
const token = await sign(
  {
    actor_type: args.data.actor,
    aud: config.data.JWT_AUDIENCE,
    exp: now + args.data.ttl * 60,
    iat: now,
    iss: config.data.JWT_ISSUER,
    sub: args.data.sub ?? `${args.data.tenant}-${args.data.actor}`,
    tenant_id: DEV_TENANTS[args.data.tenant].id,
  },
  config.data.JWT_SECRET,
  'HS256',
)

out(`${token}\n`)
