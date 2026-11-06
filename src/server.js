import { config, isRazorpayLive, isCloudinaryLive } from './config.js'
import { createApp } from './app.js'
import { connectDb, disconnectDb } from './db.js'
import { logger } from './lib/logger.js'
import { emailConfigured } from './services/mailer.js'
import { registerJobs } from './jobs/handlers.js'
import { startWorker } from './jobs/queue.js'

async function start() {
  await connectDb()
  registerJobs()
  const stopWorker = startWorker({ recurring: [{ type: 'orders.reconcileUnpaid', everyMs: 60 * 60_000 }] })

  const server = createApp().listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        email: emailConfigured() ? `${config.email.provider} (+fallback)` : 'console only',
        razorpay: isRazorpayLive ? (config.razorpay.keyId.startsWith('rzp_live') ? 'LIVE' : 'test') : 'dev stub',
        cloudinary: isCloudinaryLive,
        cors: config.corsOrigins,
      },
      'aurie-api listening',
    )
  })

  // Render sends SIGTERM on every deploy — finish in-flight requests first.
  const shutdown = (signal) => {
    logger.info({ signal }, 'shutting down')
    stopWorker()
    server.close(async () => {
      await disconnectDb().catch(() => {})
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

start().catch((err) => {
  logger.fatal({ err: err.message }, 'failed to start')
  process.exit(1)
})
