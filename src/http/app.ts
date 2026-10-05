import type { Context } from 'hono'

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { Scalar } from '@scalar/hono-api-reference'
import { requestId } from 'hono/request-id'
import { routePath } from 'hono/route'

import type { CaseStore } from '../application/cases/index.js'
import type { AppEnv } from './context.js'

import { logger } from '../logger.js'
import { SERVICE_NAME, VERSION } from '../version.js'
import { type AuthConfig, authenticate } from './auth.js'
import { caseRoutes } from './cases/routes.js'
import { mountConsole } from './console.js'
import { errorBody, handleError, validationHook } from './errors.js'
import { reportRoutes } from './reports/routes.js'

const healthSchema = z.object({
  service: z.string(),
  status: z.literal('ok'),
  version: z.string(),
})

const readySchema = z.object({
  checks: z.object({ postgres: z.literal('up') }),
  status: z.literal('ready'),
})

const openApiConfig = {
  info: {
    description:
      'Dispute case platform for an issuer chargeback operations team. Tenant identity is derived ' +
      'only from the verified bearer token, never from a header or request body.',
    title: 'Triple Dispute API',
    version: VERSION,
  },
  openapi: '3.1.0',
  servers: [{ url: 'http://localhost:3000' }],
}

export interface AppDependencies {
  auth: AuthConfig
  caseStore: CaseStore
  // Serves the development console at /console. Off unless asked for.
  console?: boolean
  // Registers middleware that must see every request, before any route: monitoring.
  instrument?: (app: OpenAPIHono<AppEnv>) => void
  // Readiness: resolves when the database answers.
  ping: () => Promise<unknown>
}

// Builds the HTTP application from its dependencies, so tests can run it against a throwaway
// database and src/index.ts against the real one.
export function createApp(deps: AppDependencies): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook })

  deps.instrument?.(app)

  app.use('*', requestId())

  app.use('*', async (c, next) => {
    const startedAt = performance.now()
    await next()
    logger().debug(
      {
        durationMs: Math.round(performance.now() - startedAt),
        method: c.req.method,
        requestId: c.get('requestId'),
        route: routePath(c as Context) || 'unmatched',
        status: c.res.status,
      },
      'request completed',
    )
  })

  const healthRoute = createRoute({
    method: 'get',
    operationId: 'healthz',
    path: '/healthz',
    responses: {
      200: {
        content: { 'application/json': { schema: healthSchema } },
        description: 'Process is alive. Does not touch the database.',
      },
    },
    summary: 'Liveness probe',
    tags: ['ops'],
  })

  const readyRoute = createRoute({
    method: 'get',
    operationId: 'readyz',
    path: '/readyz',
    responses: {
      200: {
        content: { 'application/json': { schema: readySchema } },
        description: 'Process can serve traffic, including database access.',
      },
      503: { description: 'A dependency is unavailable.' },
    },
    summary: 'Readiness probe',
    tags: ['ops'],
  })

  app.openapi(healthRoute, (c) =>
    c.json({ service: SERVICE_NAME, status: 'ok' as const, version: VERSION }),
  )

  app.openapi(readyRoute, async (c) => {
    try {
      await deps.ping()
      return c.json({ checks: { postgres: 'up' as const }, status: 'ready' as const }, 200)
    } catch (error) {
      logger().error({ err: error }, 'readiness check failed')
      return c.json(errorBody('service_unavailable', 'database unavailable'), 503)
    }
  })

  app.use('/cases', authenticate(deps.auth))
  app.use('/cases/*', authenticate(deps.auth))
  app.use('/reports/*', authenticate(deps.auth))
  app.route('/', caseRoutes(deps.caseStore))
  app.route('/', reportRoutes(deps.caseStore))

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    bearerFormat: 'JWT',
    description:
      'HS256 token minted with `npm run dev:token`. Tenant and actor come from its claims.',
    scheme: 'bearer',
    type: 'http',
  })

  app.route('/docs', Scalar.serve({ document: () => app.getOpenAPI31Document(openApiConfig) }))

  if (deps.console) mountConsole(app)

  app.notFound((c) => c.json(errorBody('route_not_found', 'no such route'), 404))
  app.onError(handleError)

  return app
}
