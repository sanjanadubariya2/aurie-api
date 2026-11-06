import { STATUS_FLOW } from '../models/Order.js'
import { isRazorpayLive, isAiLive } from '../config.js'

/**
 * The shop's business rules, defined once. createOrder.js prices with these,
 * and GET /api/settings hands the same numbers to the storefront and admin, so
 * the three apps can no longer drift (the ₹999 rule used to live in three files).
 */
export const SHOP = Object.freeze({
  currency: 'INR',
  freeShippingFrom: 999,
  shippingFee: 79,
  codLimit: 2000,
  maxPerLine: 20,
  leadTimeDays: 7, // 4 to pour and cure, 3 to ship
  unpaidOrderTtlHours: 24,
  giftWrapFee: 49,
  giftNoteMaxChars: 200,
  secretMessageMaxChars: 24,
  quoteValidDays: 7,
  maxQuoteImages: 3,
})

export function publicSettings() {
  return {
    ...SHOP,
    statusFlow: STATUS_FLOW,
    payments: { upi: true, cod: true, razorpayMode: isRazorpayLive ? 'live' : 'dev' },
    features: { ai: isAiLive },
  }
}
