import { z } from 'zod'
import Product from '../models/Product.js'
import Order from '../models/Order.js'
import { generateOrderNumber } from './orderNumber.js'
import { HttpError } from './HttpError.js'

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
      count: z.number().int().min(1).max(20),
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
    if (!product || !product.active) throw new HttpError(400, `That item is no longer available.`)

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

/** Prices a cart and creates the Order document. Shared by the plain COD/UPI
 *  checkout (routes/orders.js) and the Razorpay flow (routes/payments.js) so
 *  there is exactly one place that decides what something costs. */
export async function createOrderFromCart({ customer, items, address, payment }) {
  const lines = await priceItems(items)
  const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.count, 0)
  const shipping = subtotal >= 999 ? 0 : 79
  const total = subtotal + shipping

  if (payment === 'cod' && total > 2000) {
    throw new HttpError(400, 'Cash on delivery is not available above ₹2,000. Pay by UPI instead.')
  }

  const orderNumber = await generateOrderNumber()
  const expectedBy = new Date()
  expectedBy.setDate(expectedBy.getDate() + 7) // 4 days to pour and cure, 3 to ship

  return Order.create({
    orderNumber,
    customer: customer._id,
    items: lines,
    address,
    subtotal,
    shipping,
    total,
    payment: { method: payment },
    paymentStatus: 'pending',
    status: 'placed',
    statusHistory: [{ status: 'placed', at: new Date(), by: customer.email }],
    expectedBy,
  })
}
