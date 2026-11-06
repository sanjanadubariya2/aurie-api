import Coupon from '../models/Coupon.js'
import Order from '../models/Order.js'
import Product from '../models/Product.js'
import { HttpError } from './HttpError.js'

const REAL_SALE = { status: { $nin: ['cancelled', 'awaiting_payment'] } }

/**
 * Checks a code against a customer and priced cart lines and returns the
 * discount in whole rupees. Every rule lives here — the checkout preview and
 * order creation both call it, so the number shown is the number charged.
 */
export async function evaluateCoupon({ code, customer, lines }) {
  const coupon = await Coupon.findOne({ code: String(code || '').trim().toUpperCase() })
  const now = new Date()
  if (!coupon || !coupon.active || (coupon.startsAt && coupon.startsAt > now) || (coupon.endsAt && coupon.endsAt < now)) {
    throw new HttpError(400, 'That code is not valid right now.')
  }
  if (coupon.usageLimit && coupon.used >= coupon.usageLimit) throw new HttpError(400, 'That code has been fully used.')

  if (customer) {
    if (coupon.firstOrderOnly && (await Order.exists({ customer: customer._id, ...REAL_SALE }))) {
      throw new HttpError(400, 'That code is for a first order only.')
    }
    const usedByMe = await Order.countDocuments({ customer: customer._id, couponCode: coupon.code, ...REAL_SALE })
    if (coupon.perCustomerLimit && usedByMe >= coupon.perCustomerLimit) throw new HttpError(400, 'You have already used that code.')
  }

  // Which lines count towards it.
  let eligible = lines
  if (coupon.collection) {
    const inCollection = await Product.find({ slug: { $in: lines.map((l) => l.productId) }, collection_: coupon.collection }, { slug: 1 })
    const slugs = inCollection.map((p) => p.slug)
    eligible = lines.filter((l) => slugs.includes(l.productId))
    if (!eligible.length) throw new HttpError(400, `That code is for the ${coupon.collection} collection.`)
  }
  const base = eligible.reduce((s, l) => s + l.unitPrice * l.count, 0)
  if (base < (coupon.minSubtotal || 0)) {
    throw new HttpError(400, `Add ₹${(coupon.minSubtotal - base).toLocaleString('en-IN')} more to use that code.`)
  }

  let discount = coupon.type === 'percent' ? Math.floor((base * coupon.value) / 100) : coupon.value
  if (coupon.maxDiscount) discount = Math.min(discount, coupon.maxDiscount)
  discount = Math.min(discount, base)
  return { coupon, discount, description: coupon.description || '' }
}

/** Counts one use, once, when the sale becomes real. */
export async function countCouponUse(orderId) {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, couponCode: { $exists: true, $ne: null }, couponCounted: { $ne: true } },
    { $set: { couponCounted: true } },
  )
  if (order?.couponCode) await Coupon.updateOne({ code: order.couponCode }, { $inc: { used: 1 } })
}
