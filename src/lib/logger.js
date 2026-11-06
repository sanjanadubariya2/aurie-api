import pino from 'pino'
import { config } from '../config.js'

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
  ...(config.isProd || config.nodeEnv === 'test'
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
})
