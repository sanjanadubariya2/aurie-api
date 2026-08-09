import { Router } from 'express'
import { z } from 'zod'
import Order, { toPublicOrder } from '../models/Order.js'
import { addressSchema, itemsSchema, createOrderFromCart } from '../lib/createOrder.js'
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
 * something costs. This route covers cash-on-delivery (and a plain,
 * pay-nothing-yet UPI record) — the Razorpay-backed UPI flow that actually
 * takes payment lives at POST /payments/order.
 */

const router = Router()
router.use(requireAuth)

const orderSchema = z.object({
  items: itemsSchema,
  address: addressSchema,
  payment: z.enum(['upi', 'cod'], { errorMap: () => ({ message: 'Choose a payment method' }) }),
  // `total` may be present in the body (the frontend sends it for its own display) — it is
  // intentionally absent from this schema so Zod strips it before it can influence pricing.
})

router.post(
  '/',
  validateBody(orderSchema),
  asyncHandler(async (req, res) => {
    const { items, address, payment } = req.body
    const order = await createOrderFromCart({ customer: req.customer, items, address, payment })
    res.status(201).json({ order: toPublicOrder(order) })
  }),
)

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const orders = await Order.find({ customer: req.customer._id }).sort({ createdAt: -1 })
    res.json({ orders: orders.map(toPublicOrder) })
  }),
)

export default router
