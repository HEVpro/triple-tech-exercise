import * as Sentry from '@sentry/node'

import type { RuntimeEnv } from '../config/env.js'

import { providerOptions } from './options.js'

// A task that must run on a schedule, and when its absence becomes an alert.
export interface Schedule {
  // Minutes without a successful run before an alert is raised.
  alertAfterMinutes: number
  everyMs: number
  // Minutes a run may take before it counts as failed.
  maxRuntimeMinutes: number
}

type ProviderSchedule = NonNullable<Parameters<typeof Sentry.withMonitor>[2]>

// Monitoring: what the processes report so that the objectives in docs/SLOS.md can be watched.
//
// This folder is the only code that knows which provider receives it (Sentry today; ESLint
// forbids importing it anywhere else). The rest of the system calls these functions, so changing
// provider means rewriting this folder and nothing else. Without SENTRY_DSN nothing is
// initialised and every function here does nothing.
//
//   index.ts   any process: start, stop, watch a scheduled task, record a measure
//   http.ts    the API: failed requests and request traces

// Records the current value of a measure, for example how far behind a task is.
export function recordGauge(name: string, value: number, unit: string): void {
  Sentry.metrics.gauge(name, value, { unit })
}

// The schedule as the provider wants it. The provider creates or updates the monitor from this at
// the first run, so the alert is defined in code and cannot drift from the deployment.
export function scheduleConfig(schedule: Schedule): ProviderSchedule {
  const everyMinutes = Math.max(1, Math.round(schedule.everyMs / 60_000))
  return {
    // Minutes a run may start late before it counts as missed.
    checkinMargin: 1,
    // Consecutive missed or failed runs before the provider raises an issue.
    failureIssueThreshold: Math.ceil(schedule.alertAfterMinutes / everyMinutes),
    maxRuntime: schedule.maxRuntimeMinutes,
    recoveryThreshold: 1,
    schedule: { type: 'interval', unit: 'minute', value: everyMinutes },
  }
}

export function startMonitoring(config: RuntimeEnv): void {
  if (config.SENTRY_DSN) Sentry.init(providerOptions(config))
}

// Sends what is still queued, then stops. Call it before a process exits.
export async function stopMonitoring(): Promise<void> {
  await Sentry.close(2_000)
}

// Runs one pass of a scheduled task and tells the provider it started and how it ended, so a
// task that stops running, fails or hangs raises an alert. Rethrows what `run` throws.
export function watchSchedule<T>(
  name: string,
  schedule: Schedule,
  run: () => Promise<T>,
): Promise<T> {
  return Sentry.withMonitor(name, run, scheduleConfig(schedule))
}
