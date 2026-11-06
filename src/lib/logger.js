import { createRequire } from 'node:module'
import pino from 'pino'
import { config } from '../config.js'

// pino-pretty is a devDependency. If a host runs with NODE_ENV unset but
// installed production dependencies only, asking for it would crash startup —
// so only use it when it is actually installed.
const hasPretty = (() => {
  try {
    createRequire(import.meta.url).resolve('pino-pretty')
    return true
  } catch {
    return false
  }
})()

/**
 * One structured logger for the whole API. JSON lines in production (what
 * Render/any log drain expects), pretty output in development, silent in tests
 * unless LOG_LEVEL says otherwise.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || (config.nodeEnv === 'test' ? 'silent' : 'info'),
  redact: {
    // Never let a credential or a one-time code reach the logs.
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.code', '*.token'],
    censor: '[redacted]',
  },
  ...(config.isProd || config.nodeEnv === 'test' || !hasPretty
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
})

if (!config.isProd && process.env.RENDER) {
  logger.warn('NODE_ENV is not "production" on Render — session cookies will not be marked Secure. Set NODE_ENV=production.')
}
