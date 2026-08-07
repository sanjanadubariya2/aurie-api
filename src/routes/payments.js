import { Router } from 'express'
import { z } from 'zod'
import Order, { toPublicOrder } from '../models/Order.js'
import { createRazorpayOrder, verifyPaymentSignature } from '../services/razorpay.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { validateBody } from '../middleware/validate.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { HttpError } from '../lib/HttpError.js'

/**
 * Backend contract
 *   POST /payments/upi     { orderId, amount }                                    -> { razorpayOrderId, key }
 *   POST /payments/verify  { orderId, razorpayOrderId, razorpayPaymentId, signature } -> { order }
 *
 * The client's `amount` is a display convenience only — the Razorpay order is
 * always created for the order's own stored total.
 */

const router = Router()
router.use(requireAuth)

async function findOwnOrder(orderId, customerId) {
  const order = await Order.findOne({ orderNumber: orderId, customer: customerId })
  if (!order) throw new HttpError(404, 'Order not found')
  return order
}

router.post(
  '/upi',
  validateBody(z.object({ orderId: z.string().trim().min(1) })),
  asyncHandler(async (req, res) => {
    const order = await findOwnOrder(req.body.orderId, req.customer._id)
    if (order.payment.method !== 'upi') throw new HttpError(400, 'This order is not paying by UPI.')

    const { razorpayOrderId, key } = await createRazorpayOrder({
      amountInRupees: order.total,
      receipt: order.orderNumber,
    })

    order.payment.razorpayOrderId = razorpayOrderId
    await order.save()

    res.json({ razorpayOrderId, key })
  }),
)

router.post(
  '/verify',
  validateBody(
    z.object({
      orderId: z.string().trim().min(1),
      razorpayOrderId: z.string().trim().min(1),
      razorpayPaymentId: z.string().trim().min(1),
      signature: z.string().trim().min(1),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { orderId, razorpayOrderId, razorpayPaymentId, signature } = req.body
    const order = await findOwnOrder(orderId, req.customer._id)

    if (order.payment.razorpayOrderId !== razorpayOrderId) {
      throw new HttpError(400, 'Payment could not be verified')
    }
    if (!verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, signature })) {
      throw new HttpError(400, 'Payment could not be verified')
    }

    order.payment.status = 'paid'
    order.payment.razorpayPaymentId = razorpayPaymentId
    await order.save()

    res.json({ order: toPublicOrder(order) })
  }),
)

export default router
