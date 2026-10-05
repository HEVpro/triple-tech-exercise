import type { Env, Hono } from 'hono'

import { getClient, init, sentry } from '@sentry/hono/node'

import type { RuntimeEnv } from '../config/env.js'

import { providerOptions } from './options.js'

// The API's monitoring. Started from src/instrument.ts, which is loaded before the application
// with `--import`: the provider has to be initialised before the modules it instruments.
export function startHttpMonitoring(config: RuntimeEnv): void {
  if (config.SENTRY_DSN) init(providerOptions(config))
}

// Reports the requests that failed and names each request's trace after its route. `isFailure`
// decides what a failure is, and it must be passed: the provider's own default reports every
// error without a 3xx/4xx `status`, which would include every business rejection (a 409 for late
// evidence, a 404), and those are answers, not failures (docs/SLOS.md).
//
// Does nothing unless monitoring was started.
export function trackErrors<E extends Env>(
  app: Hono<E>,
  isFailure: (error: unknown) => boolean,
): void {
  if (!getClient()) return
  app.use(sentry(app, { shouldHandleError: isFailure }))
}
