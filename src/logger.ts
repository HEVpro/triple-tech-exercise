import pino, { type Logger } from 'pino'

import { runtimeEnv } from './config/env.js'

const redactedPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-tenant-id"]',
  'req.headers["x-actor-id"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
]

let instance: Logger | undefined

export function logger(): Logger {
  instance ??= build()
  return instance
}

function build(): Logger {
  const config = runtimeEnv()
  const pretty = config.NODE_ENV === 'development'

  return pino({
    base: { service: 'triple-dispute-api' },
    level: config.LOG_LEVEL,
    redact: { censor: '[redacted]', paths: redactedPaths },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty ? { transport: { options: { colorize: true }, target: 'pino-pretty' } } : {}),
  })
}
