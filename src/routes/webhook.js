import { Router } from 'express'
import express from 'express'
import Order from '../models/Order.js'
import { verifyWebhookSignature } from '../services/razorpay.js'
import { asyncHandler } from '../middleware/errorHandler.js'

/**
 * Razorpay's server-to-server notification for payment.captured — the only
 * reliable signal if the customer closes the tab right after paying. Must be
 * mounted with a *raw* body parser, and before the app-wide express.json(),
 * or the HMAC signature check below will fail on an already-consumed stream.
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

    if (event.event === 'payment.captured') {
      const razorpayOrderId = event.payload?.payment?.entity?.order_id
      const razorpayPaymentId = event.payload?.payment?.entity?.id
      if (razorpayOrderId) {
        await Order.updateOne(
          { 'payment.razorpayOrderId': razorpayOrderId },
          { $set: { 'payment.status': 'paid', 'payment.razorpayPaymentId': razorpayPaymentId } },
        )
      }
    }

    res.json({ received: true })
  }),
)

export default router
