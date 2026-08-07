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

/** Creates a Razorpay order for the given rupee amount and returns its id + the public key. */
export async function createRazorpayOrder({ amountInRupees, receipt }) {
  if (!isRazorpayLive) {
    // Dev mode: fabricate an id so the checkout flow is clickable before real keys exist.
    return { razorpayOrderId: `order_dev_${crypto.randomBytes(8).toString('hex')}`, key: 'rzp_test_dev' }
  }
  const razorpay = await getClient()
  const order = await razorpay.orders.create({
    amount: Math.round(amountInRupees * 100), // paise
    currency: 'INR',
    receipt,
  })
  return { razorpayOrderId: order.id, key: config.razorpay.keyId }
}

export function verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, signature }) {
  if (!isRazorpayLive) return true // dev mode has no real signature to check
  const expected = crypto
    .createHmac('sha256', config.razorpay.keySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex')
  return expected === signature
}

export function verifyWebhookSignature(rawBody, signature) {
  if (!config.razorpay.webhookSecret) return false
  const expected = crypto.createHmac('sha256', config.razorpay.webhookSecret).update(rawBody).digest('hex')
  return expected === signature
}
