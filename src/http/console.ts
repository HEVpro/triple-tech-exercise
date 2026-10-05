import type { Env, Hono } from 'hono'

import { serveStatic } from '@hono/node-server/serve-static'

// The development console (the brief's optional one-page console): a static page in ./console
// that calls the public API from the browser, with the token the user pastes. Served by the API
// itself, so there is no second server, no build step and no CORS.
//
// Alpine.js and Pico.css are served from node_modules: the page works offline and loads nothing
// from a third party. Paths are relative to the directory the process is started from.
const FILES: Readonly<Record<string, string>> = {
  '/console': './console/index.html',
  '/console/app.js': './console/app.js',
  '/console/vendor/alpine.js': './node_modules/alpinejs/dist/cdn.min.js',
  '/console/vendor/pico.css': './node_modules/@picocss/pico/css/pico.min.css',
}

export function mountConsole<E extends Env>(app: Hono<E>): void {
  for (const [route, path] of Object.entries(FILES)) {
    app.get(route, serveStatic({ path }))
  }
}
