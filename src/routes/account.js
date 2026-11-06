import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import Order from '../models/Order.js'
import Review, { toPublicReview } from '../models/Review.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { validateBody } from '../middleware/validate.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { HttpError } from '../lib/HttpError.js'
import { addressSchema, itemsSchema, priceItems } from '../lib/createOrder.js'
import { evaluateCoupon } from '../lib/coupons.js'
import { enqueue } from '../jobs/queue.js'
import { uploadImage } from '../services/cloudinary.js'
import { isCloudinaryLive } from '../config.js'
import { publicCustomer } from '../lib/serialize.js'

/**
 * Everything "my account": profile, saved addresses, wishlist, the cart mirror
 * (for abandoned-cart reminders), coupon checks and reviews. All signed-in.
 *
 *   GET   /account                         -> { customer, addresses, wishlist }
 *   PATCH /account            { name, marketingOptOut }
 *   PUT   /account/addresses  { addresses: [...] }  (max 5)
 *   PUT   /account/wishlist   { slugs: [...] }
 *   PUT   /account/cart       { lines: [...] }
 *   POST  /account/coupon     { code, items } -> { code, discount, description }
 *   GET   /account/reviewable                -> { items: [{ orderNumber, productId, name, image }] }
 *   POST  /account/reviews    multipart { orderNumber, productId, rating, text, photo? }
 *   GET   /products/:slug/reviews (public, in routes/products.js)
 */
const router = Router()
router.use(requireAuth)

const profile = (c) => ({
  customer: { ...publicCustomer(c), marketingOptOut: Boolean(c.marketingOptOut) },
  addresses: c.addresses || [],
  wishlist: c.wishlist || [],
})

router.get('/', (req, res) => res.json(profile(req.customer)))

router.patch(
  '/',
  validateBody(z.object({ name: z.string().trim().max(80).optional(), marketingOptOut: z.boolean().optional() })),
  asyncHandler(async (req, res) => {
    Object.assign(req.customer, req.body)
    await req.customer.save()
    res.json(profile(req.customer))
  }),
)

router.put(
  '/addresses',
  validateBody(z.object({ addresses: z.array(addressSchema.extend({ isDefault: z.boolean().optional().default(false) })).max(5, 'Keep at most 5 addresses') })),
  asyncHandler(async (req, res) => {
    const list = req.body.addresses
    // Exactly one default when there is anything saved.
    if (list.length && !list.some((a) => a.isDefault)) list[0].isDefault = true
    let seen = false
    req.customer.addresses = list.map((a) => {
      const isDefault = a.isDefault && !seen
      if (isDefault) seen = true
      return { ...a, isDefault }
    })
    await req.customer.save()
    res.json(profile(req.customer))
  }),
)

router.put(
  '/wishlist',
  validateBody(z.object({ slugs: z.array(z.string().trim().max(80)).max(100) })),
  asyncHandler(async (req, res) => {
    req.customer.wishlist = [...new Set(req.body.slugs)]
    await req.customer.save()
    res.json(profile(req.customer))
  }),
)

const cartLine = z.object({
  productId: z.string().trim().min(1).max(80),
  tierId: z.string().trim().min(1).max(20),
  count: z.number().int().min(1).max(20),
  note: z.string().trim().max(200).optional().default(''),
})

/** Mirrors the browser cart so a reminder can go out if it sits untouched for a day. */
router.put(
  '/cart',
  validateBody(z.object({ lines: z.array(cartLine).max(50) })),
  asyncHandler(async (req, res) => {
    req.customer.cart = { lines: req.body.lines, updatedAt: new Date(), remindedAt: undefined }
    await req.customer.save()
    if (req.body.lines.length && !req.customer.marketingOptOut) {
      // One pending reminder per customer; it re-checks the cart when it runs.
      await enqueue('email.abandonedCart', { customerId: req.customer._id.toString() }, { delayMs: 24 * 3_600_000, uniqueKey: `cart:${req.customer._id}` })
    }
    res.json({ ok: true })
  }),
)

router.post(
  '/coupon',
  validateBody(z.object({ code: z.string().trim().min(1).max(30), items: itemsSchema })),
  asyncHandler(async (req, res) => {
    const lines = await priceItems(req.body.items)
    const { coupon, discount, description } = await evaluateCoupon({ code: req.body.code, customer: req.customer, lines })
    res.json({ code: coupon.code, discount, description })
  }),
)

// --------------------------------------------------------------- reviews ---
router.get(
  '/reviewable',
  asyncHandler(async (req, res) => {
    const orders = await Order.find({ customer: req.customer._id, status: 'delivered' }).sort({ createdAt: -1 }).limit(30)
    const done = await Review.find({ customer: req.customer._id }, { order: 1, product: 1 })
    const reviewed = new Set(done.map((r) => `${r.order}:${r.product}`))
    const items = []
    for (const o of orders) {
      for (const l of o.items) {
        if (l.tierId === 'quote' || reviewed.has(`${o._id}:${l.productId}`)) continue
        if (items.some((i) => i.orderNumber === o.orderNumber && i.productId === l.productId)) continue
        items.push({ orderNumber: o.orderNumber, productId: l.productId, name: l.name, image: l.image })
      }
    }
    res.json({ items })
  }),
)

const photo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (/^image\//.test(file.mimetype) ? cb(null, true) : cb(new HttpError(400, 'The photo must be an image.'))),
})

router.post(
  '/reviews',
  photo.single('photo'),
  validateBody(
    z.object({
      orderNumber: z.string().trim().min(1),
      productId: z.string().trim().min(1),
      rating: z.coerce.number().int().min(1, 'Pick 1 to 5 stars').max(5),
      text: z.string().trim().max(1000).optional().default(''),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { orderNumber, productId, rating, text } = req.body
    const order = await Order.findOne({ orderNumber, customer: req.customer._id })
    if (!order) throw new HttpError(404, 'Order not found')
    if (order.status !== 'delivered') throw new HttpError(400, 'You can review once it has been delivered.')
    const line = order.items.find((l) => l.productId === productId)
    if (!line) throw new HttpError(400, 'That item is not in this order.')

    let uploaded
    if (req.file) {
      if (!isCloudinaryLive) throw new HttpError(503, 'Photo uploads are not available right now — post the review without one.')
      const { secure_url: url, public_id: publicId } = await uploadImage(req.file.buffer, 'aurie/reviews')
      uploaded = { url, publicId }
    }

    const first = (order.address?.fullName || req.customer.name || '').trim().split(/\s+/)
    const authorName = first[0] ? `${first[0]}${first[1] ? ` ${first[1][0]}.` : ''}` : 'A customer'

    try {
      const review = await Review.create({
        product: productId,
        productName: line.name,
        customer: req.customer._id,
        order: order._id,
        authorName,
        city: order.address?.city,
        rating,
        text,
        photo: uploaded,
      })
      res.status(201).json({ review: toPublicReview(review), status: review.status })
    } catch (err) {
      if (err?.code === 11000) throw new HttpError(409, 'You have already reviewed this item from this order.')
      throw err
    }
  }),
)

export default router
