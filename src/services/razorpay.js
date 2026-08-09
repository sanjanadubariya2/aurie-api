import crypto from 'node:crypto'
import { config, isRazorpayLive } from '../config.js'

let client
async function getClient() {
  if (!client) {
    const { default: Razorpay } = await import('razorpay')
    client = new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret })
  }
  return client
}

/** Creates a Razorpay order for an already-server-computed rupee amount.
 *  `aurieOrderId` goes into `notes` so the webhook — which only gets Razorpay's
 *  own order id — has a way to cross-check it against the Aurie order. */
export async function createRazorpayOrder({ amountInRupees, receipt, aurieOrderId }) {
  const amount = Math.round(amountInRupees * 100) // paise — Razorpay never takes rupees
  if (!isRazorpayLive) {
    // Dev mode: fabricate an id so the checkout flow is clickable before real keys exist.
    return {
      razorpayOrderId: `order_dev_${crypto.randomBytes(8).toString('hex')}`,
      amount,
      currency: 'INR',
      keyId: 'rzp_test_dev',
    }
  }
  const razorpay = await getClient()
  const order = await razorpay.orders.create({
    amount,
    currency: 'INR',
    receipt,
    notes: { aurieOrderId },
  })
  return { razorpayOrderId: order.id, amount: order.amount, currency: order.currency, keyId: config.razorpay.keyId }
}

/** Constant-time comparison — a plain `===` on a signature check leaks how
 *  many leading characters matched via response timing, which is exactly
 *  the kind of thing an attacker automates against. Buffers must be equal
 *  length for timingSafeEqual, so mismatched lengths are rejected first. */
function safeEqualHex(expectedHex, actualHex) {
  if (typeof actualHex !== 'string') return false
  const expected = Buffer.from(expectedHex, 'hex')
  const actual = Buffer.from(actualHex, 'hex')
  if (expected.length !== actual.length) return false
  return crypto.timingSafeEqual(expected, actual)
}

export function verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, signature }) {
  if (!isRazorpayLive) return true // dev mode has no real signature to check
  const expected = crypto
    .createHmac('sha256', config.razorpay.keySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex')
  return safeEqualHex(expected, signature)
}

export function verifyWebhookSignature(rawBody, signature) {
  if (!config.razorpay.webhookSecret) return false
  const expected = crypto.createHmac('sha256', config.razorpay.webhookSecret).update(rawBody).digest('hex')
  return safeEqualHex(expected, signature)
}
