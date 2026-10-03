import { describe, expect, it } from 'vitest'

import type { CaseStore } from '../src/application/cases/index.js'

import { createApp } from '../src/http/app.js'
import { AUTH } from './support/api.js'

// No database: these endpoints must work without one.
const app = createApp({
  auth: AUTH,
  caseStore: {} as CaseStore,
  ping: () => Promise.resolve(),
})

describe('health endpoints', () => {
  it('reports liveness without touching the database', async () => {
    const response = await app.request('/healthz')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      service: 'triple-dispute-api',
      status: 'ok',
      version: '0.1.0',
    })
  })

  it('serves an OpenAPI 3.1 document with the case routes and bearer auth', async () => {
    const response = await app.request('/docs/openapi.json')

    expect(response.status).toBe(200)
    const document = (await response.json()) as {
      components: { securitySchemes: Record<string, unknown> }
      openapi: string
      paths: Record<string, unknown>
    }
    expect(document.openapi).toBe('3.1.0')
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining(['/healthz', '/cases', '/cases/{id}', '/cases/{id}/history']),
    )
    expect(document.components.securitySchemes).toHaveProperty('bearerAuth')
  })

  it('exposes prometheus metrics', async () => {
    await (await app.request('/healthz')).text()

    const metrics = await app.request('/metrics')

    expect(metrics.status).toBe(200)
    expect(await metrics.text()).toContain('http_request_duration_seconds')
  })

  it('reports not ready, in the error envelope, when the database does not answer', async () => {
    const failing = createApp({
      auth: AUTH,
      caseStore: {} as CaseStore,
      ping: () => Promise.reject(new Error('connection refused')),
    })

    const response = await failing.request('/readyz')

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'service_unavailable' },
    })
  })

  it('answers an unknown route with the error envelope', async () => {
    const response = await app.request('/nope')

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'route_not_found' } })
  })
})
