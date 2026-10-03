import type { MiddlewareHandler } from 'hono'

import { verify } from 'hono/jwt'
import { z } from 'zod'

import type { AppEnv } from './context.js'

import { errorBody } from './errors.js'

export interface AuthConfig {
  audience: string
  issuer: string
  secret: string
}

// What a token must carry. hono/jwt checks exp only when present, so it is required here: a
// token without exp would never expire. `system` is not accepted: only the sweeper is the
// system, and it does not call the API.
const claimsSchema = z.object({
  actor_type: z.enum(['human', 'agent']),
  exp: z.number(),
  sub: z.string().min(1).max(200),
  tenant_id: z.uuid(),
})

// Verifies the bearer token (HS256 signature, issuer, audience, expiry) and derives the tenant
// and actor from its claims. Nothing in the request can override them (D-12): there is no
// tenant header, body field or query parameter.
export function authenticate(config: AuthConfig): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1]
    if (!token) return unauthenticated(c, 'a bearer token is required')

    let payload: unknown
    try {
      payload = await verify(token, config.secret, {
        alg: 'HS256',
        aud: config.audience,
        iss: config.issuer,
      })
    } catch {
      return unauthenticated(c, 'the token is not valid')
    }

    const claims = claimsSchema.safeParse(payload)
    if (!claims.success) return unauthenticated(c, 'the token is missing required claims')

    c.set('principal', {
      actor: { id: claims.data.sub, type: claims.data.actor_type },
      tenantId: claims.data.tenant_id,
    })
    await next()
    return undefined
  }
}

function unauthenticated(c: Parameters<MiddlewareHandler<AppEnv>>[0], message: string) {
  c.header('WWW-Authenticate', 'Bearer')
  return c.json(errorBody('unauthenticated', message), 401)
}
