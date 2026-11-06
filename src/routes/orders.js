import { Router } from 'express'
import { z } from 'zod'
import Order, { toPublicOrder } from '../models/Order.js'
import { addressSchema, itemsSchema, createOrderFromCart } from '../lib/createOrder.js'
import { sendConfirmationOnce } from '../lib/orderEvents.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { validateBody } from '../middleware/validate.js'
import { asyncHandler } from '../middleware/errorHandler.js'

/**
 * Backend contract
 *   POST /orders   { items, address, payment } -> { order }
 *   GET  /orders                                -> { orders: [...] }
 *
 * `items[].count`/`note` come from the client; everything priced comes from
 * the database. A request body can say anything — it never gets to say what
 * something costs. This route is cash-on-delivery only — the Razorpay-backed
 * UPI flow lives at POST /payments/order.
 */

const router = Router()
router.use(requireAuth)

const orderSchema = z.object({
  items: itemsSchema,
  address: addressSchema,
  // Cash on delivery only. UPI must go through POST /payments/order so that
  // Razorpay — not the request body — is what says an order was paid for.
  payment: z.literal('cod', { errorMap: () => ({ message: 'Pay by UPI through the payment page instead.' }) }),
  // `total` may be present in the body (the frontend sends it for its own display) — it is
  // intentionally absent from this schema so Zod strips it before it can influence pricing.
})

router.post(
  '/',
  validateBody(orderSchema),
  asyncHandler(async (req, res) => {
    const { items, address, payment } = req.body
    const order = await createOrderFromCart({ customer: req.customer, items, address, payment })
    sendConfirmationOnce(order._id) // fire and forget — never blocks the checkout
    res.status(201).json({ order: toPublicOrder(order) })
  }),
)

router.get(
  '/',
  asyncHandler(async (req, res) => {
    // An unpaid UPI attempt is not an order yet — the customer closed Razorpay
    // or the payment failed. Showing it as "Order placed" would be a lie.
    const orders = await Order.find({ customer: req.customer._id, status: { $ne: 'awaiting_payment' } }).sort({
      createdAt: -1,
    })
    res.json({ orders: orders.map(toPublicOrder) })
  }),
)

export default router
