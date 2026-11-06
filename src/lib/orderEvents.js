import Order from '../models/Order.js'
import Quote from '../models/Quote.js'
import { enqueue } from '../jobs/queue.js'
import { logger } from './logger.js'

/**
 * Queues the "we have your order" email. The job retries with backoff if the
 * mail provider is down, and the uniqueKey means a verify call and a webhook
 * racing each other can never queue it twice. Never throws.
 */
export async function sendConfirmationOnce(orderId) {
  try {
    await enqueue('email.orderConfirmation', { orderId: String(orderId) }, { uniqueKey: `confirm:${orderId}` })
  } catch (err) {
    logger.error({ orderId: String(orderId), err: err.message }, 'could not queue confirmation email')
  }
}

/** Queues the status-change email the admin panel promises ("Save and notify customer"). */
export async function notifyStatusChange(order) {
  try {
    await enqueue('email.orderStatus', { orderId: String(order._id), status: order.status })
  } catch (err) {
    logger.error({ order: order.orderNumber, err: err.message }, 'could not queue status email')
  }
}

/**
 * Marks a Razorpay order paid and moves it into the fulfilment flow. Used by
 * POST /payments/verify, the webhook and the reconcile job. Idempotent: the
 * paymentStatus filter means a second caller changes nothing and gets null.
 */
export async function markOrderPaid({ razorpayOrderId, razorpayPaymentId, customerId, by }) {
  const filter = { razorpayOrderId, paymentStatus: { $ne: 'paid' } }
  if (customerId) filter.customer = customerId

  const order = await Order.findOne(filter)
  if (!order) return null

  const update = { $set: { paymentStatus: 'paid', razorpayPaymentId } }
  // Only promote an order still waiting on payment. One already cancelled stays
  // cancelled — the money needs refunding, which is flagged loudly here.
  if (order.status === 'awaiting_payment') {
    update.$set.status = 'placed'
    update.$push = { statusHistory: { status: 'placed', at: new Date(), by } }
  } else if (order.status === 'cancelled') {
    logger.error({ order: order.orderNumber }, 'payment captured for a cancelled order — refund it in Razorpay')
  }

  const updated = await Order.findOneAndUpdate({ _id: order._id, paymentStatus: { $ne: 'paid' } }, update, { new: true })
  if (updated?.quote) {
    // The custom quote this order paid for is now settled.
    await Quote.updateOne({ _id: updated.quote }, { $set: { status: 'paid', order: updated._id } })
  }
  if (updated && updated.status !== 'cancelled') await sendConfirmationOnce(updated._id)
  return updated
}
