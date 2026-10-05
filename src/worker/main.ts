import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'

import { sweepDeadlines } from '../application/cases/index.js'
import { runtimeEnv } from '../config/env.js'
import { postgresCaseStore } from '../infrastructure/db/case-store.js'
import { closeDbPool, database } from '../infrastructure/db/pool.js'
import { logger } from '../logger.js'
import { recordGauge, startMonitoring, stopMonitoring, watchSchedule } from '../monitoring/index.js'
import { startLoop } from './loop.js'

// The deadline sweeper.
//
//   npm run worker   a long-running loop, every SWEEP_INTERVAL_MS (this exercise's default)
//   npm run sweep    one pass and exit: what a scheduler would run in production, for example an
//                    EventBridge rule invoking a Lambda, or a Kubernetes CronJob, every minute
//
// Both run sweepDeadlines; several copies can run at once without processing a case twice.
//
// Every pass is watched (docs/SLOS.md): monitoring is told when it starts and how it ends, so a
// sweeper that stops, fails or hangs raises an alert, and how late the most overdue case was
// recorded, so one that runs but cannot keep up does too.

const BATCH_SIZE = 500
const MAX_BATCHES_PER_RUN = 100

const MONITOR_NAME = 'deadline-sweeper'
// Sweep lag objective (docs/SLOS.md): alert after this long without a successful pass.
const ALERT_AFTER_MINUTES = 15
const MAX_PASS_MINUTES = 5

const config = runtimeEnv()
startMonitoring(config)
const log = logger().child({ component: 'deadline-sweeper' })
const store = postgresCaseStore(database())
const { values } = parseArgs({ options: { once: { default: false, type: 'boolean' } } })

async function sweep(): Promise<void> {
  const sweepRunId = randomUUID()
  const result = await sweepDeadlines(store, {
    batchSize: BATCH_SIZE,
    maxBatches: MAX_BATCHES_PER_RUN,
    sweepRunId,
  })
  recordGauge('deadline_sweeper.max_lag_seconds', result.maxLagSeconds, 'second')
  log.info({ ...result, sweepRunId }, 'sweep finished')
}

function watchedSweep(): Promise<void> {
  return watchSchedule(
    MONITOR_NAME,
    {
      alertAfterMinutes: ALERT_AFTER_MINUTES,
      everyMs: config.SWEEP_INTERVAL_MS,
      maxRuntimeMinutes: MAX_PASS_MINUTES,
    },
    sweep,
  )
}

if (values.once) {
  try {
    await watchedSweep()
  } catch (error) {
    log.error({ err: error }, 'sweep failed')
    process.exitCode = 1
  } finally {
    // A one-pass process exits at once: what monitoring has queued must be sent first.
    await stopMonitoring()
    await closeDbPool()
  }
} else {
  log.info({ intervalMs: config.SWEEP_INTERVAL_MS }, 'deadline sweeper started')
  const loop = startLoop({
    intervalMs: config.SWEEP_INTERVAL_MS,
    onError: (error) => {
      log.error({ err: error }, 'sweep failed; retrying at the next interval')
    },
    run: watchedSweep,
  })

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'stopping after the current sweep')
    await loop.stop()
    await stopMonitoring()
    await closeDbPool()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}
