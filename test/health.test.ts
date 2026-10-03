import { describe, expect, it } from 'vitest'

import { app } from '../src/http/app.js'

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

  it('serves an OpenAPI 3.1 document', async () => {
    const response = await app.request('/docs/openapi.json')

    expect(response.status).toBe(200)
    const document = (await response.json()) as { openapi: string; paths: Record<string, unknown> }
    expect(document.openapi).toBe('3.1.0')
    expect(Object.keys(document.paths)).toContain('/healthz')
  })

  it('exposes prometheus metrics', async () => {
    const response = await app.request('/healthz')
    await response.text()

    const metrics = await app.request('/metrics')

    expect(metrics.status).toBe(200)
    const body = await metrics.text()
    expect(body).toContain('http_request_duration_seconds')
  })
})
