import Order from '../models/Order.js'
import { defineJob } from './queue.js'
import { SHOP } from '../lib/settings.js'
import { logger } from '../lib/logger.js'
import Quote from '../models/Quote.js'
import { config } from '../config.js'
import {
  sendOrderConfirmationEmail,
  sendOrderStatusEmail,
  sendQuoteReceivedEmail,
  sendQuoteNotifyShopEmail,
  sendQuoteReadyEmail,
  sendQuoteDeclinedEmail,
  sendReviewRequestEmail,
  sendAbandonedCartEmail,
} from '../services/mailer.js'
import Customer from '../models/Customer.js'
import Review from '../models/Review.js'
import { priceItems } from '../lib/createOrder.js'
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

  const loadQuote = (quoteId) => Quote.findById(quoteId).populate('customer', 'email')

  defineJob('email.quoteReceived', async ({ quoteId }) => {
    const quote = await loadQuote(quoteId)
    if (!quote?.customer?.email) return
    await sendQuoteReceivedEmail(quote.customer.email, quote)
    if (config.notifyEmail) {
      const adminUrl = `${config.adminUrl}/quotes?open=${quote._id}`
      await sendQuoteNotifyShopEmail(config.notifyEmail, quote, quote.customer.email, adminUrl)
    }
  })

  defineJob('email.quoteReady', async ({ quoteId }) => {
    const quote = await loadQuote(quoteId)
    if (!quote?.customer?.email || quote.status !== 'quoted') return
    await sendQuoteReadyEmail(quote.customer.email, quote, `${config.storefrontUrl}/quotes/${quote._id}`)
  })

  defineJob('email.quoteDeclined', async ({ quoteId }) => {
    const quote = await loadQuote(quoteId)
    if (!quote?.customer?.email || quote.status !== 'declined') return
    await sendQuoteDeclinedEmail(quote.customer.email, quote)
  })

  // Three days after delivery: ask for a review, unless they already wrote one
  // or opted out of these emails.
  defineJob('email.reviewRequest', async ({ orderId }) => {
    const order = await Order.findById(orderId).populate('customer', 'email marketingOptOut')
    if (!order?.customer?.email || order.customer.marketingOptOut || order.status !== 'delivered') return
    if (await Review.exists({ order: order._id })) return
    await sendReviewRequestEmail(order.customer.email, order, `${config.storefrontUrl}/account?review=${order.orderNumber}`)
  })

  // A day after the cart last changed, if nothing was ordered since.
  defineJob('email.abandonedCart', async ({ customerId }) => {
    const customer = await Customer.findById(customerId)
    const cart = customer?.cart
    if (!customer || customer.marketingOptOut || !cart?.lines?.length || cart.remindedAt) return
    if (Date.now() - new Date(cart.updatedAt).getTime() < 23 * 3_600_000) return // changed since — a newer job will run
    if (await Order.exists({ customer: customer._id, createdAt: { $gte: cart.updatedAt } })) return
    // Price from the database — the reminder never shows a stale price.
    const lines = await priceItems(cart.lines).catch(() => null)
    if (!lines?.length) return
    await sendAbandonedCartEmail(customer.email, lines, `${config.storefrontUrl}/checkout`)
    customer.cart.remindedAt = new Date()
    await customer.save()
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
       
      const payment = await fetchCapturedPayment(order.razorpayOrderId).catch((err) => {
        log.warn({ order: order.orderNumber, err: err.message }, 'razorpay lookup failed')
        return undefined // unknown — do not cancel on a failed lookup
      })
      if (payment) {
         
        await markOrderPaid({ razorpayOrderId: order.razorpayOrderId, razorpayPaymentId: payment.id, by: 'reconcile-job' })
        paid++
      } else if (payment === null && order.createdAt.getTime() < cutoff) {
        order.status = 'cancelled'
        order.statusHistory.push({ status: 'cancelled', at: new Date(), by: 'system: payment never completed' })
         
        await order.save()
        cancelled++
      }
    }
    if (paid || cancelled) log.info({ paid, cancelled }, 'reconciled unpaid UPI orders')
  })
}
