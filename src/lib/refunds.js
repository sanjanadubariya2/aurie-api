import Order from '../models/Order.js'
import { HttpError } from './HttpError.js'
import { refundPayment } from '../services/razorpay.js'
import { audit } from './audit.js'

/**
 * Refunds money on a paid UPI order through Razorpay and records it. Partial
 * refunds are allowed (a broken jar out of four); the total can never exceed
 * what was paid. COD orders have nothing to refund here — that money is
 * returned by hand.
 */
export async function refundOrder({ order, amount, reason, by }) {
  if (order.payment?.method !== 'upi') throw new HttpError(400, 'Cash on delivery orders are refunded by hand, not through Razorpay.')
  if (!['paid', 'partially_refunded'].includes(order.paymentStatus) || !order.razorpayPaymentId) {
    throw new HttpError(400, 'There is no captured payment on this order to refund.')
  }
  const remaining = order.total - (order.refundedTotal || 0)
  const value = amount ?? remaining
  if (!(value > 0)) throw new HttpError(400, 'Nothing left to refund on this order.')
  if (value > remaining) throw new HttpError(400, `At most ₹${remaining} can still be refunded.`)

  const refund = await refundPayment({
    razorpayPaymentId: order.razorpayPaymentId,
    amountInRupees: value,
    notes: { order: order.orderNumber, reason: reason || '' },
  })

  const refundedTotal = (order.refundedTotal || 0) + value
  const updated = await Order.findByIdAndUpdate(
    order._id,
    {
      $push: {
        refunds: {
          refundId: refund.id,
          amount: value,
          status: refund.status === 'processed' ? 'processed' : 'pending',
          reason,
          by,
          at: new Date(),
        },
      },
      $set: { refundedTotal, paymentStatus: refundedTotal >= order.total ? 'refunded' : 'partially_refunded' },
    },
    { new: true },
  )
  await audit(by, 'refund.create', order.orderNumber, { amount: value, refundId: refund.id, reason })
  return updated
}
