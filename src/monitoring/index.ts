import * as Sentry from '@sentry/node'

import type { RuntimeEnv } from '../config/env.js'

import { providerOptions } from './options.js'

// Monitoring: what the processes report so that the objectives in docs/SLOS.md can be watched.
//
// This folder is the only code that knows which provider receives it (Sentry today; ESLint
// forbids importing it anywhere else). The rest of the system calls these functions, so changing
// provider means rewriting this folder and nothing else. Without SENTRY_DSN nothing is
// initialised and every function here does nothing.
//
//   index.ts   any process: start, stop
//   http.ts    the API: failed requests and request traces

export function startMonitoring(config: RuntimeEnv): void {
  if (config.SENTRY_DSN) Sentry.init(providerOptions(config))
}

// Sends what is still queued, then stops. Call it before a process exits.
export async function stopMonitoring(): Promise<void> {
  await Sentry.close(2_000)
}
