import type { NodeOptions } from '@sentry/node'

import type { RuntimeEnv } from '../config/env.js'

import { SERVICE_NAME, VERSION } from '../version.js'

export function providerOptions(config: RuntimeEnv): NodeOptions {
  return {
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,
    release: `${SERVICE_NAME}@${VERSION}`,
    tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
  }
}
