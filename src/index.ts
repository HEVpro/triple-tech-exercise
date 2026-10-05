import { serve } from '@hono/node-server'

import { apiEnv } from './config/env.js'
import { createApp } from './http/app.js'
import { isExpectedError } from './http/errors.js'
import { postgresCaseStore } from './infrastructure/db/case-store.js'
import { closeDbPool, database, dbPool } from './infrastructure/db/pool.js'
import { logger } from './logger.js'
import { trackErrors } from './monitoring/http.js'
import { stopMonitoring } from './monitoring/index.js'
import { SERVICE_NAME, VERSION } from './version.js'

const config = apiEnv()
const log = logger()

const app = createApp({
  auth: { audience: config.JWT_AUDIENCE, issuer: config.JWT_ISSUER, secret: config.JWT_SECRET },
  caseStore: postgresCaseStore(database()),
  // Only what the API answers with a 500 is a failure; business rejections are answers.
  instrument: (hono) => {
    trackErrors(hono, (error) => !isExpectedError(error))
  },
  ping: () => dbPool().query('SELECT 1'),
})

const server = serve({ fetch: app.fetch, port: config.PORT })

log.info({ authMode: config.AUTH_MODE, port: config.PORT }, `${SERVICE_NAME} v${VERSION} listening`)

let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log.info({ signal }, 'shutting down')
  server.close()
  await stopMonitoring()
  await closeDbPool()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('unhandledRejection', (reason) => {
  log.fatal({ err: reason }, 'unhandled rejection')
})
