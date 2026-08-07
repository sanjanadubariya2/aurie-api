import { Router } from 'express'
import { z } from 'zod'
import Product from '../models/Product.js'
import Order, { toPublicOrder } from '../models/Order.js'
import { generateOrderNumber } from '../lib/orderNumber.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { validateBody } from '../middleware/validate.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { HttpError } from '../lib/HttpError.js'

/**
 * Backend contract
 *   POST /orders   { items, address, payment } -> { order }
 *   GET  /orders                                -> { orders: [...] }
 *
 * `items[].count`/`note` come from the client; everything priced comes from
 * the database. A request body can say anything — it never gets to say what
 * something costs.
 */

const router = Router()
router.use(requireAuth)

const addressSchema = z.object({
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

const orderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().trim().min(1),
        tierId: z.string().trim().min(1),
        count: z.number().int().min(1).max(20),
        note: z.string().trim().max(200).optional().default(''),
      }),
    )
    .min(1, 'Your cart is empty'),
  address: addressSchema,
  payment: z.enum(['upi', 'cod'], { errorMap: () => ({ message: 'Choose a payment method' }) }),
  // `total` may be present in the body (the frontend sends it for its own display) — it is
  // intentionally absent from this schema so Zod strips it before it can influence pricing.
})

async function priceItems(items) {
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

router.post(
  '/',
  validateBody(orderSchema),
  asyncHandler(async (req, res) => {
    const { items, address, payment } = req.body

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

    const order = await Order.create({
      orderNumber,
      customer: req.customer._id,
      items: lines,
      address,
      subtotal,
      shipping,
      total,
      payment: { method: payment, status: payment === 'cod' ? 'pending' : 'pending' },
      status: 'placed',
      statusHistory: [{ status: 'placed', at: new Date(), by: req.customer.email }],
      expectedBy,
    })

    res.status(201).json({ order: toPublicOrder(order) })
  }),
)

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const orders = await Order.find({ customer: req.customer._id }).sort({ createdAt: -1 })
    res.json({ orders: orders.map(toPublicOrder) })
  }),
)

export default router
