import { describe, expect, it } from 'vitest'

import type { CaseStore } from '../../src/application/cases/index.js'

import { createApp } from '../../src/http/app.js'
import { AUTH } from '../support/api.js'

// The console is a static page: what is tested here is that it is served with everything it
// loads, from this process alone, and only when asked for. What it shows comes from the API,
// which has its own tests; the page itself was checked in a browser (NOTES 2.32).
function app(console: boolean): ReturnType<typeof createApp> {
  return createApp({
    auth: AUTH,
    caseStore: {} as CaseStore,
    console,
    ping: () => Promise.resolve(),
  })
}

describe('development console', () => {
  it('serves the page and everything it loads, with no third-party request', async () => {
    const page = await app(true).request('/console')
    const html = await page.text()

    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(html).toContain('<title>Dispute console</title>')

    const loaded = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((match) => match[1] ?? '')
    expect(loaded).toEqual([
      '/console/vendor/pico.css',
      '/console/app.js',
      '/console/vendor/alpine.js',
    ])
    for (const path of loaded) {
      const asset = await app(true).request(path)
      expect(asset.status, path).toBe(200)
    }
  })

  it('does not exist unless it is switched on', async () => {
    const response = await app(false).request('/console')

    expect(response.status).toBe(404)
  })
})
