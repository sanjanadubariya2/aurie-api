import { Router } from 'express'
import express from 'express'
import Order from '../models/Order.js'
import { verifyWebhookSignature } from '../services/razorpay.js'
import { asyncHandler } from '../middleware/errorHandler.js'

/**
 * Razorpay's server-to-server notification — the real source of truth for
 * whether money actually moved. A customer can pay and close the tab before
 * the client-side /payments/verify call ever fires; this webhook still lands
 * either way.
 *
 * Must be mounted with a *raw* body parser, and before the app-wide
 * express.json() in server.js — the HMAC signature below is computed over
 * the exact bytes Razorpay sent, and express.json() would already have
 * consumed and re-serialized the stream by the time this handler saw it,
 * silently changing the bytes just enough to fail every signature check.
 * This is the single most common cause of "webhook signature invalid."
 */

const router = Router()

router.post(
  '/',
  express.raw({ type: '*/*' }),
  asyncHandler(async (req, res) => {
    const signature = req.headers['x-razorpay-signature']
    if (!signature || !verifyWebhookSignature(req.body, signature)) {
      return res.status(400).json({ message: 'Invalid signature' })
    }

    const event = JSON.parse(req.body.toString('utf8'))
    const razorpayOrderId = event.payload?.payment?.entity?.order_id
    const razorpayPaymentId = event.payload?.payment?.entity?.id

    if (event.event === 'payment.captured' && razorpayOrderId) {
      const order = await Order.findOne({ razorpayOrderId })
      // Razorpay retries webhooks until it gets a 200 — an order that's
      // already paid means this is a retry of one we already processed.
      // Re-applying it would be harmless here, but the guard is what makes
      // that a guarantee rather than a coincidence, and cheaper than a write.
      if (order && order.paymentStatus !== 'paid') {
        order.paymentStatus = 'paid'
        order.razorpayPaymentId = razorpayPaymentId
        order.status = 'placed'
        await order.save()
      }
    } else if (event.event === 'payment.failed' && razorpayOrderId) {
      const order = await Order.findOne({ razorpayOrderId })
      // Never downgrade a payment that's already captured — a failed event
      // can arrive for a retried attempt on an order that a *different*
      // attempt already paid for.
      if (order && order.paymentStatus === 'pending') {
        order.paymentStatus = 'failed'
        await order.save()
      }
    }

    // Always 200, even for events above that found no matching order and
    // for event types we don't handle at all — a non-200 here just means
    // Razorpay retries the same event forever.
    res.json({ received: true })
  }),
)

export default router
