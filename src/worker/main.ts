import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'

import { sweepDeadlines } from '../application/cases/index.js'
import { runtimeEnv } from '../config/env.js'
import { postgresCaseStore } from '../infrastructure/db/case-store.js'
import { closeDbPool, database } from '../infrastructure/db/pool.js'
import { logger } from '../logger.js'
import { startLoop } from './loop.js'

// The deadline sweeper.
//
//   npm run worker   a long-running loop, every SWEEP_INTERVAL_MS (this exercise's default)
//   npm run sweep    one pass and exit: what a scheduler would run in production, for example an
//                    EventBridge rule invoking a Lambda, or a Kubernetes CronJob, every minute
//
// Both run sweepDeadlines; several copies can run at once without processing a case twice.

const BATCH_SIZE = 500
const MAX_BATCHES_PER_RUN = 100

const config = runtimeEnv()
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
  log.info({ ...result, sweepRunId }, 'sweep finished')
}

if (values.once) {
  try {
    await sweep()
  } catch (error) {
    log.error({ err: error }, 'sweep failed')
    process.exitCode = 1
  } finally {
    await closeDbPool()
  }
} else {
  log.info({ intervalMs: config.SWEEP_INTERVAL_MS }, 'deadline sweeper started')
  const loop = startLoop({
    intervalMs: config.SWEEP_INTERVAL_MS,
    onError: (error) => {
      log.error({ err: error }, 'sweep failed; retrying at the next interval')
    },
    run: sweep,
  })

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'stopping after the current sweep')
    await loop.stop()
    await closeDbPool()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}
