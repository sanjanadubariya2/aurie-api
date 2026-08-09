import { Router } from 'express'
import { z } from 'zod'
import Order, { toPublicOrder } from '../models/Order.js'
import { addressSchema, itemsSchema, createOrderFromCart } from '../lib/createOrder.js'
import { createRazorpayOrder, verifyPaymentSignature } from '../services/razorpay.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { validateBody } from '../middleware/validate.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { HttpError } from '../lib/HttpError.js'

/**
 * Backend contract
 *   POST /payments/order    { items, address }                                       -> { razorpayOrderId, amount, currency, keyId, orderId }
 *   POST /payments/verify   { razorpay_order_id, razorpay_payment_id, razorpay_signature } -> { order }
 *   POST /payments/webhook  (mounted separately in server.js, ahead of express.json())
 *
 * Cash on delivery never touches this file — it's created directly via
 * POST /orders. This is the UPI-via-Razorpay path only.
 */

const router = Router()
router.use(requireAuth)

router.post(
  '/order',
  validateBody(z.object({ items: itemsSchema, address: addressSchema })),
  asyncHandler(async (req, res) => {
    const { items, address } = req.body

    // Step 1+2: reprice from the database and create the Aurie order first.
    // Deliberately before calling Razorpay — if the process dies between the
    // two calls, we have a pending order to reconcile, not a payment with no
    // record of what it was for.
    const order = await createOrderFromCart({ customer: req.customer, items, address, payment: 'upi' })

    // Step 3: a Razorpay order for that exact, server-computed total.
    const { razorpayOrderId, amount, currency, keyId } = await createRazorpayOrder({
      amountInRupees: order.total,
      receipt: order.orderNumber,
      aurieOrderId: order._id.toString(),
    })

    order.razorpayOrderId = razorpayOrderId
    await order.save()

    res.status(201).json({ razorpayOrderId, amount, currency, keyId, orderId: order.orderNumber })
  }),
)

router.post(
  '/verify',
  validateBody(
    z.object({
      razorpay_order_id: z.string().trim().min(1),
      razorpay_payment_id: z.string().trim().min(1),
      razorpay_signature: z.string().trim().min(1),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { razorpay_order_id: razorpayOrderId, razorpay_payment_id: razorpayPaymentId, razorpay_signature: signature } = req.body

    const order = await Order.findOne({ razorpayOrderId, customer: req.customer._id })
    if (!order) throw new HttpError(404, 'Order not found')

    // Already verified (a retried client call, a duplicate tab) — no need to
    // re-check, and re-checking a used signature teaches nothing new.
    if (order.paymentStatus === 'paid') return res.json({ order: toPublicOrder(order) })

    const ok = verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, signature })
    if (!ok) {
      // The browser saying "payment succeeded" is not proof of anything — only a
      // verified signature is. Log loudly: a mismatch here is either an attempted
      // forgery or a real bug, and either way someone should see it.
      console.error(`Razorpay signature mismatch: order=${order.orderNumber} razorpayOrderId=${razorpayOrderId}`)
      throw new HttpError(400, 'Payment could not be verified')
    }

    order.paymentStatus = 'paid'
    order.razorpayPaymentId = razorpayPaymentId
    order.status = 'placed'
    await order.save()

    res.json({ order: toPublicOrder(order) })
  }),
)

export default router
