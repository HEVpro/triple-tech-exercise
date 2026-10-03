import { serve } from '@hono/node-server'

import { env } from './config/env.js'
import { app } from './http/app.js'
import { closeDbPool } from './infrastructure/db/pool.js'
import { logger } from './logger.js'
import { SERVICE_NAME, VERSION } from './version.js'

const config = env()
const log = logger()

const server = serve({ fetch: app.fetch, port: config.PORT })

log.info({ authMode: config.AUTH_MODE, port: config.PORT }, `${SERVICE_NAME} v${VERSION} listening`)

let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log.info({ signal }, 'shutting down')
  server.close()
  await closeDbPool()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('unhandledRejection', (reason) => {
  log.fatal({ err: reason }, 'unhandled rejection')
})
