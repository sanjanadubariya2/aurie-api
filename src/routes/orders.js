import { Router } from 'express'
import { z } from 'zod'
import Order, { toPublicOrder } from '../models/Order.js'
import { addressSchema, itemsSchema, giftSchema, neededBySchema, couponCodeSchema, createOrderFromCart } from '../lib/createOrder.js'
import { countCouponUse } from '../lib/coupons.js'
import { sendConfirmationOnce, notifyStatusChange } from '../lib/orderEvents.js'
import { assignInvoiceNumber } from '../lib/invoice.js'
import { refundOrder } from '../lib/refunds.js'
import { audit } from '../lib/audit.js'
import { HttpError } from '../lib/HttpError.js'
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
  gift: giftSchema,
  neededBy: neededBySchema,
  couponCode: couponCodeSchema,
  // `total` may be present in the body (the frontend sends it for its own display) — it is
  // intentionally absent from this schema so Zod strips it before it can influence pricing.
})

router.post(
  '/',
  validateBody(orderSchema),
  asyncHandler(async (req, res) => {
    const { items, address, payment, gift, neededBy, couponCode } = req.body
    const order = await createOrderFromCart({ customer: req.customer, items, address, payment, gift, neededBy, couponCode })
    await countCouponUse(order._id)
    const invoiceNumber = await assignInvoiceNumber(order._id) // COD is a sale the moment it is placed
    await sendConfirmationOnce(order._id) // queued — a mail outage never blocks the checkout
    res.status(201).json({ order: toPublicOrder({ ...order.toObject(), invoiceNumber }) })
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

/**
 * Customer cancels an order themselves — only while it is still "placed"
 * (nothing poured yet), matching the refund policy. A paid UPI order is
 * refunded in full through Razorpay automatically.
 */
router.post(
  '/:ref/cancel',
  asyncHandler(async (req, res) => {
    let order = await Order.findOne({ orderNumber: req.params.ref, customer: req.customer._id })
    if (!order) throw new HttpError(404, 'Order not found')
    if (order.status !== 'placed') {
      throw new HttpError(400, 'Pouring has started, so this order can no longer be cancelled. Message us if something is wrong.')
    }
    if (order.payment.method === 'upi' && order.paymentStatus === 'paid') {
      order = await refundOrder({ order, reason: 'Cancelled by customer', by: req.customer.email })
    }
    order.status = 'cancelled'
    order.statusHistory.push({ status: 'cancelled', at: new Date(), by: `${req.customer.email} (customer)` })
    await order.save()
    await audit(req.customer.email, 'order.cancel.customer', order.orderNumber)
    await notifyStatusChange(order)
    res.json({ order: toPublicOrder(order) })
  }),
)

export default router
