import { Router } from 'express'
import multer from 'multer'
import bcrypt from 'bcryptjs'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import Customer from '../models/Customer.js'
import Order, { STATUSES } from '../models/Order.js'
import Product, { toAdminProduct } from '../models/Product.js'
import { signToken } from '../services/token.js'
import { uploadImage, destroyImage } from '../services/cloudinary.js'
import { sendOrderStatusEmail } from '../services/mailer.js'
import { publicCustomer } from '../lib/serialize.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { validateBody } from '../middleware/validate.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { HttpError } from '../lib/HttpError.js'

const router = Router()
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Client-side validation is a courtesy, not a guarantee — check again here.
    if (!file.mimetype.startsWith('image/')) return cb(new HttpError(400, 'File must be an image.'))
    cb(null, true)
  },
})

// ---------------------------------------------------------------- login ---
// Unprotected on purpose — this is how an admin gets the token that the
// requireAuth/requireAdmin pair below then checks for every other route.
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, standardHeaders: true, legacyHeaders: false })

router.post(
  '/login',
  loginLimiter,
  validateBody(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body
    const admin = await Customer.findOne({ email, role: 'admin' })
    const ok = admin?.passwordHash && (await bcrypt.compare(password, admin.passwordHash))
    // One message for both failures — do not reveal which admin emails exist
    if (!ok) return res.status(401).json({ message: 'That email and password do not match.' })

    res.json({ token: signToken(admin), admin: publicCustomer(admin) })
  }),
)

// Everything below here requires a signed-in admin.
router.use(requireAuth, requireAdmin)

// Lets the admin app confirm a stored token is still good on page load —
// without this, refreshing any page silently signs the admin back out.
router.get('/me', (req, res) => {
  res.json({ admin: publicCustomer(req.customer) })
})

// --------------------------------------------------------------- orders ---
router.get(
  '/orders',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(100, Number(req.query.limit) || 25)
    const filter = req.query.status ? { status: req.query.status } : {}

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate('customer', 'email name phone')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Order.countDocuments(filter),
    ])

    res.json({ orders, page, limit, total })
  }),
)

const orderUpdateSchema = z.object({
  status: z.enum(STATUSES).optional(),
  // aurie-admin sends `null` (not omitted) for these when its form fields are
  // blank — e.g. every status update before "shipped", where courier/tracking
  // don't exist yet. Without .nullable() every one of those PATCHes 400s.
  courier: z.string().trim().optional().nullable(),
  trackingNumber: z.string().trim().optional().nullable(),
})

router.patch(
  '/orders/:id',
  validateBody(orderUpdateSchema),
  asyncHandler(async (req, res) => {
    const { status, courier, trackingNumber } = req.body
    const order = await Order.findById(req.params.id).populate('customer', 'email')
    if (!order) throw new HttpError(404, 'Order not found')

    if (status) {
      order.status = status
      order.statusHistory.push({ status, at: new Date(), by: req.customer.email })
    }
    if (courier) order.courier = courier
    if (trackingNumber) order.trackingNumber = trackingNumber
    await order.save()

    // Fire and forget — a failed email must not fail the status update.
    if (status && order.customer?.email) {
      sendOrderStatusEmail(order.customer.email, order).catch(console.error)
    }

    res.json({ order })
  }),
)

// ------------------------------------------------------------- products ---
router.get(
  '/products',
  asyncHandler(async (req, res) => {
    const products = await Product.find().sort({ createdAt: -1 })
    res.json({ products: products.map(toAdminProduct) })
  }),
)

const slugify = (name) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** aurie-admin's product form never collects a slug — it's an internal
 *  storefront-URL detail, not something a shop owner should have to think
 *  about. Derive one from the name and disambiguate on collision. */
async function uniqueSlugFrom(name, excludeId) {
  const base = slugify(name) || 'product'
  let slug = base
  let n = 2
  // eslint-disable-next-line no-await-in-loop
  while (await Product.exists({ slug, _id: { $ne: excludeId } })) {
    slug = `${base}-${n}`
    n++
  }
  return slug
}

const tierSchema = z.object({
  id: z.enum(['single', 'double', 'combo']),
  label: z.string().trim().min(1),
  qty: z.number().int().min(1),
  price: z.number().min(0),
})

const productSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]+$/, 'Slug can only contain lowercase letters, numbers and hyphens')
    .optional(),
  name: z.string().trim().min(1),
  collection: z.string().trim().min(1),
  image: z.string().trim().optional().default(''),
  scent: z.string().trim().optional().default(''),
  burn: z.string().trim().optional().default(''),
  blurb: z.string().trim().optional().default(''),
  badge: z.string().trim().optional().default(''),
  quote: z.boolean().optional().default(false),
  // The admin UI calls this `inStock`; the model calls it `active`. Accept
  // either name from a client and resolve to one value below.
  active: z.boolean().optional(),
  inStock: z.boolean().optional(),
  tiers: z.array(tierSchema).optional().default([]),
})

const resolveActive = (body, fallback) =>
  body.inStock !== undefined ? body.inStock : body.active !== undefined ? body.active : fallback

router.post(
  '/products',
  validateBody(productSchema),
  asyncHandler(async (req, res) => {
    const { collection, active, inStock, slug, ...rest } = req.body
    const product = await Product.create({
      ...rest,
      slug: slug || (await uniqueSlugFrom(req.body.name)),
      collection_: collection,
      active: resolveActive(req.body, true),
    })
    res.status(201).json({ product: toAdminProduct(product) })
  }),
)

router.patch(
  '/products/:id',
  validateBody(productSchema.partial()),
  asyncHandler(async (req, res) => {
    const { collection, active, inStock, slug, ...rest } = req.body
    const patch = { ...rest }
    if (collection) patch.collection_ = collection
    if (slug) patch.slug = slug
    if (active !== undefined || inStock !== undefined) patch.active = resolveActive(req.body)

    const product = await Product.findByIdAndUpdate(req.params.id, patch, { new: true })
    if (!product) throw new HttpError(404, 'Product not found')
    res.json({ product: toAdminProduct(product) })
  }),
)

router.delete(
  '/products/:id',
  asyncHandler(async (req, res) => {
    // A real delete, not the same soft-hide the inStock toggle uses — the
    // admin UI is explicit that this one is permanent ("hide it instead" is
    // the other button). Past orders are unaffected: they hold their own
    // name/image/price snapshot, never a live reference to this document.
    const product = await Product.findByIdAndDelete(req.params.id)
    if (!product) throw new HttpError(404, 'Product not found')
    if (product.imagePublicId) await destroyImage(product.imagePublicId)
    res.json({ product: toAdminProduct(product) })
  }),
)

router.post(
  '/products/:id/image',
  imageUpload.single('image'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Attach an image.')
    const product = await Product.findById(req.params.id)
    if (!product) throw new HttpError(404, 'Product not found')

    const { secure_url, public_id } = await uploadImage(req.file.buffer)
    const oldPublicId = product.imagePublicId

    product.image = secure_url
    product.imagePublicId = public_id
    await product.save()

    // Only remove the old asset once the new one is safely stored — never before.
    if (oldPublicId) await destroyImage(oldPublicId)

    res.json({ url: secure_url })
  }),
)

// ---------------------------------------------------------------- stats ---
// Shape and field names are dictated by aurie-admin's src/api/stats.js — it
// only trusts this route if `revenue` is a number and `days` is an array;
// otherwise it silently falls back to computing the same numbers client-side
// from the orders list. Mirrors that fallback's own "last 14 days, or
// all-time if nothing recent" logic so the two never disagree.
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const DAYS = 14
    const since = new Date(Date.now() - DAYS * 86_400_000)
    // Counts as revenue: a Razorpay-verified payment, or a COD order (which
    // has no Razorpay-verified paymentStatus to check — COD is cash on the
    // doorstep, not something this app watches get paid).
    const paid = { $or: [{ paymentStatus: 'paid' }, { 'payment.method': 'cod' }] }

    const recentCount = await Order.countDocuments({ ...paid, createdAt: { $gte: since } })
    const basis = recentCount > 0 ? { ...paid, createdAt: { $gte: since } } : paid

    const [totals, pending, cod, dayRows, topRows] = await Promise.all([
      Order.aggregate([{ $match: basis }, { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: '$total' } } }]),
      Order.countDocuments({ status: { $in: ['placed', 'confirmed'] } }),
      Order.countDocuments({ ...basis, 'payment.method': { $ne: 'upi' } }),
      Order.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            revenue: {
              $sum: {
                $cond: [{ $or: [{ $eq: ['$paymentStatus', 'paid'] }, { $eq: ['$payment.method', 'cod'] }] }, '$total', 0],
              },
            },
            orders: { $sum: 1 },
          },
        },
      ]),
      Order.aggregate([
        { $match: basis },
        { $unwind: '$items' },
        { $group: { _id: '$items.name', count: { $sum: '$items.count' } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
    ])

    const orderCount = totals[0]?.orders || 0
    const revenue = totals[0]?.revenue || 0
    const dayMap = new Map(dayRows.map((d) => [d._id, d]))
    const days = Array.from({ length: DAYS }).map((_, i) => {
      const date = new Date(Date.now() - (DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10)
      const row = dayMap.get(date)
      return { date, revenue: row?.revenue || 0, orders: row?.orders || 0 }
    })

    res.json({
      stats: {
        revenue,
        orderCount,
        averageOrder: orderCount ? Math.round(revenue / orderCount) : 0,
        pending,
        codShare: orderCount ? Math.round((cod / orderCount) * 100) : 0,
        days,
        topProducts: topRows.map((t) => ({ name: t._id, count: t.count })),
      },
    })
  }),
)

export default router
