import Order from '../models/Order.js'
import { defineJob } from './queue.js'
import { SHOP } from '../lib/settings.js'
import { logger } from '../lib/logger.js'
import { sendOrderConfirmationEmail, sendOrderStatusEmail } from '../services/mailer.js'
import { fetchCapturedPayment } from '../services/razorpay.js'
import { markOrderPaid } from '../lib/orderEvents.js'

const log = logger.child({ module: 'jobs' })

/** Every job type the API knows. Imported once by server.js (and tests). */
export function registerJobs() {
  defineJob('email.orderConfirmation', async ({ orderId }) => {
    const order = await Order.findById(orderId).populate('customer', 'email')
    if (!order?.customer?.email || order.confirmationSentAt) return
    await sendOrderConfirmationEmail(order.customer.email, order)
    order.confirmationSentAt = new Date()
    await order.save()
  })

  defineJob('email.orderStatus', async ({ orderId, status }) => {
    const order = await Order.findById(orderId).populate('customer', 'email')
    // Skip if the order has moved on again since this was queued — the newer
    // status has its own job, and two emails out of order read as a glitch.
    if (!order?.customer?.email || order.status !== status) return
    await sendOrderStatusEmail(order.customer.email, order)
  })

  /**
   * Hourly. A UPI order stuck in awaiting_payment either (a) was paid but the
   * webhook never arrived — ask Razorpay and promote it — or (b) was abandoned
   * — cancel it once it is older than the TTL so it stops cluttering reports.
   */
  defineJob('orders.reconcileUnpaid', async () => {
    const stale = await Order.find({ status: 'awaiting_payment' }).limit(200)
    const cutoff = Date.now() - SHOP.unpaidOrderTtlHours * 3_600_000
    let paid = 0
    let cancelled = 0
    for (const order of stale) {
      // eslint-disable-next-line no-await-in-loop
      const payment = await fetchCapturedPayment(order.razorpayOrderId).catch((err) => {
        log.warn({ order: order.orderNumber, err: err.message }, 'razorpay lookup failed')
        return undefined // unknown — do not cancel on a failed lookup
      })
      if (payment) {
        // eslint-disable-next-line no-await-in-loop
        await markOrderPaid({ razorpayOrderId: order.razorpayOrderId, razorpayPaymentId: payment.id, by: 'reconcile-job' })
        paid++
      } else if (payment === null && order.createdAt.getTime() < cutoff) {
        order.status = 'cancelled'
        order.statusHistory.push({ status: 'cancelled', at: new Date(), by: 'system: payment never completed' })
        // eslint-disable-next-line no-await-in-loop
        await order.save()
        cancelled++
      }
    }
    if (paid || cancelled) log.info({ paid, cancelled }, 'reconciled unpaid UPI orders')
  })
}
