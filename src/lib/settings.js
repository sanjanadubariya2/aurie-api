import { STATUS_FLOW } from '../models/Order.js'
import { isRazorpayLive, isAiLive } from '../config.js'
import { isShiprocketLive } from '../services/shiprocket.js'

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

/**
 * Who is selling — printed on invoices and packing slips. Set these in the
 * environment once the business details are final (they must match Razorpay
 * KYC and, if registered, the GST certificate). GST_RATE is the percentage
 * already included in prices (ask your CA: candles are HSN 3406); 0 means the
 * invoice says "Bill of supply" with no tax breakup.
 */
export const BUSINESS = Object.freeze({
  name: process.env.BUSINESS_NAME || 'Aurie',
  legalName: process.env.BUSINESS_LEGAL_NAME || 'Aurie',
  address: process.env.BUSINESS_ADDRESS || 'Mumbai, Maharashtra, India',
  state: process.env.BUSINESS_STATE || 'Maharashtra',
  gstin: process.env.BUSINESS_GSTIN || '',
  email: process.env.BUSINESS_EMAIL || 'orders@aurie.website',
  phone: process.env.BUSINESS_PHONE || '',
  gstRate: Number(process.env.GST_RATE || 0),
  hsn: process.env.HSN_CODE || '3406',
})

export function publicSettings() {
  return {
    ...SHOP,
    statusFlow: STATUS_FLOW,
    payments: { upi: true, cod: true, razorpayMode: isRazorpayLive ? 'live' : 'dev' },
    business: BUSINESS,
    features: { ai: isAiLive, shiprocket: isShiprocketLive() },
  }
}
