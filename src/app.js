import express from 'express'
import mongoose from 'mongoose'
import helmet from 'helmet'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import crypto from 'node:crypto'
import { pinoHttp } from 'pino-http'
import { config } from './config.js'
import { logger } from './lib/logger.js'
import { publicSettings } from './lib/settings.js'
import { originCheck } from './middleware/originCheck.js'
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js'
import webhookRouter from './routes/webhook.js'
import authRouter from './routes/auth.js'
import catalogRouter from './routes/products.js'
import ordersRouter from './routes/orders.js'
import paymentsRouter from './routes/payments.js'
import adminRouter from './routes/admin.js'
import quotesRouter from './routes/quotes.js'
import aiRouter from './routes/ai.js'
import shippingRouter from './routes/shipping.js'
import accountRouter from './routes/account.js'

/** Builds the Express app without connecting or listening — server.js does
 *  that, and the tests import this directly. */
export function createApp() {
  const app = express()

  // One reverse-proxy hop (Render/Railway) sets X-Forwarded-For. Trusting
  // exactly one hop makes rate limits key on the real visitor's IP.
  app.set('trust proxy', 1)

  // Every request gets an id (echoed back as X-Request-Id) so a customer's
  // "it failed at 3:12pm" can be traced to one line in the logs.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = req.headers['x-request-id'] || crypto.randomUUID()
        res.setHeader('X-Request-Id', id)
        return id
      },
      autoLogging: { ignore: (req) => req.url === '/health' },
      customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ status: res.statusCode }),
      },
    }),
  )

  app.use(helmet())
  app.use(cors({ origin: config.corsOrigins, credentials: true }))

  // Razorpay's webhook needs the raw body for its HMAC check, so it is mounted
  // before express.json() consumes the stream.
  app.use('/api/payments/webhook', webhookRouter)

  app.use(express.json({ limit: '100kb' }))
  app.use(cookieParser())
  app.use(originCheck)

  // A generous ceiling on top of the tighter per-route limits (OTP, admin login).
  app.use('/api', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }))

  // Fails (so the host restarts the app) when Mongo is unreachable.
  app.get('/health', (req, res) => {
    const db = mongoose.connection.readyState === 1
    res.status(db ? 200 : 503).json({ ok: db, db })
  })

  // Business rules (delivery fee, COD limit, statuses) — the front ends read
  // these instead of hardcoding their own copies.
  app.get('/api/settings', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300')
    res.json({ settings: publicSettings() })
  })

  app.use('/api/auth', authRouter)
  app.use('/api', catalogRouter)
  app.use('/api/orders', ordersRouter)
  app.use('/api/payments', paymentsRouter)
  app.use('/api/quotes', quotesRouter)
  app.use('/api/ai', aiRouter)
  app.use('/api/shipping', shippingRouter)
  app.use('/api/account', accountRouter)
  app.use('/api/admin', adminRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
