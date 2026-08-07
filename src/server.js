import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import { config } from './config.js'
import { connectDb } from './db.js'
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js'
import webhookRouter from './routes/webhook.js'
import authRouter from './routes/auth.js'
import catalogRouter from './routes/products.js'
import ordersRouter from './routes/orders.js'
import paymentsRouter from './routes/payments.js'
import adminRouter from './routes/admin.js'

const app = express()

app.use(helmet())
app.use(
  cors({
    origin: config.corsOrigins,
    credentials: true,
  }),
)

// Razorpay's webhook needs the raw request body to check its HMAC signature, so
// it must be mounted before the app-wide express.json() consumes the stream.
app.use('/api/payments/webhook', webhookRouter)

app.use(express.json())
app.use(cookieParser())

// A generous ceiling on top of the tighter per-route limits (OTP, admin login).
app.use('/api', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }))

app.get('/health', (req, res) => res.json({ ok: true }))

app.use('/api/auth', authRouter)
app.use('/api', catalogRouter) // GET /api/products, GET /api/collections
app.use('/api/orders', ordersRouter)
app.use('/api/payments', paymentsRouter)
app.use('/api/admin', adminRouter)

app.use(notFoundHandler)
app.use(errorHandler)

async function start() {
  await connectDb()
  app.listen(config.port, () => console.log(`aurie-api listening on :${config.port}`))
}

start().catch((err) => {
  console.error('Failed to start:', err)
  process.exit(1)
})

export default app
