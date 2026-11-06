import Order from '../models/Order.js'
import { sendOrderConfirmationEmail } from '../services/mailer.js'

/**
 * Sends the "we have your order" email exactly once per order. The claim on
 * `confirmationSentAt` is atomic, so the Razorpay verify call and the webhook
 * racing each other can never both send it. Never throws — an email outage
 * must not fail a checkout that has already succeeded.
 */
export async function sendConfirmationOnce(orderId) {
  try {
    const order = await Order.findOneAndUpdate(
      { _id: orderId, confirmationSentAt: { $exists: false } },
      { $set: { confirmationSentAt: new Date() } },
      { new: true },
    ).populate('customer', 'email')
    if (!order?.customer?.email) return
    await sendOrderConfirmationEmail(order.customer.email, order)
  } catch (err) {
    console.error(`Order confirmation email failed for ${orderId}:`, err.message)
  }
}

/**
 * Marks a Razorpay order paid and moves it into the fulfilment flow. Used by
 * both POST /payments/verify and the webhook. The filter on paymentStatus makes
 * it idempotent: the second caller gets null back and does nothing.
 */
export async function markOrderPaid({ razorpayOrderId, razorpayPaymentId, customerId, by }) {
  const filter = { razorpayOrderId, paymentStatus: { $ne: 'paid' } }
  if (customerId) filter.customer = customerId

  const update = {
    $set: { paymentStatus: 'paid', razorpayPaymentId },
  }
  // Only promote an order that is still waiting on payment. One the admin has
  // already cancelled stays cancelled (and needs a refund, flagged below).
  const order = await Order.findOne(filter)
  if (!order) return null
  if (order.status === 'awaiting_payment') {
    update.$set.status = 'placed'
    update.$push = { statusHistory: { status: 'placed', at: new Date(), by } }
  } else if (order.status === 'cancelled') {
    console.error(`Payment captured for cancelled order ${order.orderNumber} — refund it from the Razorpay dashboard.`)
  }

  const updated = await Order.findOneAndUpdate({ _id: order._id, paymentStatus: { $ne: 'paid' } }, update, { new: true })
  if (updated && updated.status !== 'cancelled') sendConfirmationOnce(updated._id)
  return updated
}
