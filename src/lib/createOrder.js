import { z } from 'zod'
import Product from '../models/Product.js'
import Order from '../models/Order.js'
import { generateOrderNumber } from './orderNumber.js'
import { HttpError } from './HttpError.js'
import { SHOP } from './settings.js'
import { evaluateCoupon } from './coupons.js'

// Shared by routes/orders.js (COD + plain UPI) and routes/payments.js (the
// Razorpay flow) so the two never drift on what a valid cart/address looks like.
export const addressSchema = z.object({
  fullName: z.string().trim().min(1, 'Enter the name for the delivery label'),
  phone: z
    .string()
    .trim()
    .regex(/^[6-9]\d{9}$/, 'Enter a 10-digit Indian mobile number'),
  line1: z.string().trim().min(1, 'Enter the flat, building and street'),
  line2: z.string().trim().optional().default(''),
  city: z.string().trim().min(1, 'Enter the city'),
  state: z.string().trim().min(1, 'Enter the state'),
  pincode: z
    .string()
    .trim()
    .regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit PIN code'),
  notes: z.string().trim().max(500).optional().default(''),
})

export const itemsSchema = z
  .array(
    z.object({
      productId: z.string().trim().min(1),
      tierId: z.string().trim().min(1),
      count: z.number().int().min(1).max(SHOP.maxPerLine),
      note: z.string().trim().max(200).optional().default(''),
    }),
  )
  .min(1, 'Your cart is empty')

/** Looks every item up in Mongo and returns priced, snapshot-ready line items.
 *  The client sends product/tier ids and a quantity — never a price. */
export async function priceItems(items) {
  const slugs = [...new Set(items.map((i) => i.productId))]
  const products = await Product.find({ slug: { $in: slugs } })
  const bySlug = new Map(products.map((p) => [p.slug, p]))

  return items.map((item) => {
    const product = bySlug.get(item.productId)
    if (!product || !product.active) {
      throw new HttpError(400, `${product?.name || 'An item in your cart'} is no longer available. Remove it and try again.`)
    }
    if (product.quote) throw new HttpError(400, `${product.name} is priced on request. Message us for a quote.`)

    const tier = product.tiers.find((t) => t.id === item.tierId)
    if (!tier) throw new HttpError(400, `Choose a valid size for ${product.name}.`)

    return {
      key: `${product.slug}::${tier.id}::${item.note || ''}`,
      productId: product.slug,
      name: product.name,
      image: product.image,
      tierId: tier.id,
      tierLabel: tier.label,
      unitPrice: tier.price,
      count: item.count,
      note: item.note || '',
    }
  })
}

export const FREE_SHIPPING_FROM = SHOP.freeShippingFrom
export const SHIPPING_FEE = SHOP.shippingFee
export const COD_LIMIT = SHOP.codLimit

/** Gift options chosen at checkout. */
export const giftSchema = z
  .object({
    wrap: z.boolean().optional().default(false),
    note: z.string().trim().max(SHOP.giftNoteMaxChars, `Keep the gift note under ${SHOP.giftNoteMaxChars} characters`).optional().default(''),
    hidePrices: z.boolean().optional().default(false),
  })
  .optional()

/** The earliest date (YYYY-MM-DD, India time) we can realistically deliver. */
export function earliestDeliveryDate(from = new Date()) {
  const d = new Date(from.getTime() + SHOP.leadTimeDays * 86_400_000)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

/** "Needed by" date — optional, but if given it must be one we can meet. */
export const neededBySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a valid date')
  .refine((v) => v >= earliestDeliveryDate(), {
    message: `That is too soon — candles take about ${SHOP.leadTimeDays} days to pour, cure and ship.`,
  })
  .optional()
  .or(z.literal('').transform(() => undefined))

export const couponCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .max(30)
  .optional()
  .or(z.literal('').transform(() => undefined))

function baseOrder({ customer, lines, address, payment, gift, neededBy, freeShipping = false, discount = 0, couponCode }) {
  const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.count, 0)
  // Free delivery is judged on the pre-discount subtotal: a code never costs
  // the customer their free shipping.
  const shipping = freeShipping || subtotal >= FREE_SHIPPING_FROM ? 0 : SHIPPING_FEE
  const giftWrapFee = gift?.wrap ? SHOP.giftWrapFee : 0
  const total = subtotal - discount + shipping + giftWrapFee

  if (payment === 'cod' && total > COD_LIMIT) {
    throw new HttpError(400, `Cash on delivery is not available above ₹${COD_LIMIT.toLocaleString('en-IN')}. Pay by UPI instead.`)
  }

  // A UPI order is only a real order once Razorpay confirms the money — until
  // then it waits outside the fulfilment flow (see STATUSES in models/Order.js).
  const status = payment === 'upi' ? 'awaiting_payment' : 'placed'
  const expectedBy = new Date(Date.now() + SHOP.leadTimeDays * 86_400_000)

  return {
    customer: customer._id,
    items: lines,
    address,
    subtotal,
    shipping,
    giftWrapFee,
    ...(couponCode ? { couponCode, discount } : {}),
    gift: gift ? { wrap: gift.wrap, note: gift.note || '', hidePrices: gift.hidePrices } : undefined,
    neededBy: neededBy ? new Date(`${neededBy}T00:00:00+05:30`) : undefined,
    total,
    payment: { method: payment },
    paymentStatus: 'pending',
    status,
    statusHistory: [{ status, at: new Date(), by: customer.email }],
    expectedBy,
  }
}

/** Prices a cart and creates the Order document. Shared by COD checkout
 *  (routes/orders.js) and the Razorpay flow (routes/payments.js) so there is
 *  exactly one place that decides what something costs. */
export async function createOrderFromCart({ customer, items, address, payment, gift, neededBy, couponCode }) {
  const lines = await priceItems(items)
  const applied = couponCode ? await evaluateCoupon({ code: couponCode, customer, lines }) : null
  return Order.create({
    orderNumber: await generateOrderNumber(),
    ...baseOrder({ customer, lines, address, payment, gift, neededBy, discount: applied?.discount || 0, couponCode: applied?.coupon.code }),
  })
}

/** Turns an accepted custom quote into an order (UPI only — custom work is
 *  paid up front). The price is the one the admin set, read from the quote
 *  document, never from the request. Delivery is included in a quote. */
export async function createOrderFromQuote({ customer, quote, address, gift }) {
  const line = {
    key: `quote::${quote.number}`,
    productId: quote.productId || `quote:${quote.number}`,
    name: quote.productName ? `${quote.productName} (custom)` : 'Custom order',
    image: quote.images?.[0]?.url || '',
    tierId: 'quote',
    tierLabel: `Quote ${quote.number}`,
    unitPrice: quote.price,
    count: 1,
    note: quote.message || '',
  }
  const neededBy = quote.neededBy ? quote.neededBy.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : undefined
  return Order.create({
    orderNumber: await generateOrderNumber(),
    quote: quote._id,
    ...baseOrder({ customer, lines: [line], address, payment: 'upi', gift, neededBy, freeShipping: true }),
  })
}
