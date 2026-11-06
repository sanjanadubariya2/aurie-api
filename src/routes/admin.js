import { Router } from 'express'
import multer from 'multer'
import bcrypt from 'bcryptjs'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import Customer from '../models/Customer.js'
import Order, { STATUSES, STATUS_FLOW, TRACKED_STATUSES } from '../models/Order.js'
import CollectionModel, { toPublicCollection } from '../models/Collection.js'
import Quote, { toPublicQuote, QUOTE_STATUSES } from '../models/Quote.js'
import { enqueue } from '../jobs/queue.js'
import { SHOP } from '../lib/settings.js'
import Product, { toAdminProduct } from '../models/Product.js'
import { authenticator } from 'otplib'
import QRCode from 'qrcode'
import { startSession, endSession } from '../lib/session.js'
import { encrypt, decrypt } from '../lib/crypto.js'
import { uploadImage, destroyImage } from '../services/cloudinary.js'
import { notifyStatusChange } from '../lib/orderEvents.js'
import { publicCustomer } from '../lib/serialize.js'
import { requireAdminSession } from '../middleware/requireAuth.js'
import { requireAdmin, requireOwner } from '../middleware/requireAdmin.js'
import { auditReq } from '../lib/audit.js'
import opsRouter from './adminOps.js'
import { validateBody } from '../middleware/validate.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { HttpError } from '../lib/HttpError.js'

const router = Router()
const adminProfile = (a) => ({ ...publicCustomer(a), totpEnabled: Boolean(a.totpEnabled) })
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
  validateBody(
    z.object({
      email: z.string().trim().toLowerCase().email(),
      password: z.string().min(1),
      code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app').optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { email, password, code } = req.body
    const admin = await Customer.findOne({ email, role: { $in: ['admin', 'staff'] } })
    const ok = admin?.passwordHash && (await bcrypt.compare(password, admin.passwordHash))
    // One message for both failures — do not reveal which admin emails exist
    if (!ok) return res.status(401).json({ message: 'That email and password do not match.' })

    if (admin.totpEnabled) {
      // Password was right — ask for the second factor without issuing anything yet.
      if (!code) return res.status(401).json({ message: 'Enter the code from your authenticator app.', needsTotp: true })
      if (!authenticator.verify({ token: code, secret: decrypt(admin.totpSecretEnc) })) {
        return res.status(401).json({ message: 'That authenticator code is not right. Try the current one.', needsTotp: true })
      }
    }

    const token = startSession(res, admin, 'admin')
    res.json({ token, admin: adminProfile(admin) })
  }),
)

router.post('/logout', (req, res) => {
  endSession(res, 'admin')
  res.json({ ok: true })
})

// Everything below here requires a signed-in admin.
router.use(requireAdminSession, requireAdmin)

// Prices and the catalogue are the owner's call; staff can look but not change.
router.use('/products', (req, res, next) => (req.method === 'GET' ? next() : requireOwner(req, res, next)))
router.use(opsRouter)

// Lets the admin app confirm a stored token is still good on page load —
// without this, refreshing any page silently signs the admin back out.
router.get('/me', (req, res) => {
  res.json({ admin: adminProfile(req.customer) })
})

// ---------------------------------------------------------- two-factor ---
// Setup is two steps so a half-finished setup can never lock the admin out:
// /2fa/setup stores a pending secret, /2fa/enable turns it on only after the
// admin proves their authenticator app produces matching codes.
router.post(
  '/2fa/setup',
  asyncHandler(async (req, res) => {
    if (req.customer.totpEnabled) throw new HttpError(400, 'Two-factor is already on. Turn it off first to re-pair.')
    const secret = authenticator.generateSecret()
    req.customer.totpSecretEnc = encrypt(secret)
    await req.customer.save()
    const otpauthUrl = authenticator.keyuri(req.customer.email, 'Aurie Admin', secret)
    res.json({ otpauthUrl, secret, qr: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 }) })
  }),
)

const totpCode = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') })

router.post(
  '/2fa/enable',
  validateBody(totpCode),
  asyncHandler(async (req, res) => {
    if (!req.customer.totpSecretEnc) throw new HttpError(400, 'Start the setup first.')
    if (!authenticator.verify({ token: req.body.code, secret: decrypt(req.customer.totpSecretEnc) })) {
      throw new HttpError(400, 'That code did not match. Check your phone clock is set automatically.')
    }
    req.customer.totpEnabled = true
    req.customer.tokenVersion = (req.customer.tokenVersion || 0) + 1 // sign out other sessions
    await req.customer.save()
    startSession(res, req.customer, 'admin') // keep this one
    res.json({ totpEnabled: true })
  }),
)

router.post(
  '/2fa/disable',
  validateBody(totpCode.extend({ password: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const passwordOk = await bcrypt.compare(req.body.password, req.customer.passwordHash || '')
    const codeOk = req.customer.totpEnabled && authenticator.verify({ token: req.body.code, secret: decrypt(req.customer.totpSecretEnc) })
    if (!passwordOk || !codeOk) throw new HttpError(400, 'Password or code is not right.')
    req.customer.totpEnabled = false
    req.customer.totpSecretEnc = undefined
    await req.customer.save()
    res.json({ totpEnabled: false })
  }),
)

// --------------------------------------------------------------- orders ---
router.get(
  '/orders',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))
    const status = String(req.query.status || '')
    // Unpaid UPI attempts stay out of the default list — they are not orders
    // to fulfil. Ask for ?status=awaiting_payment explicitly to see them.
    const filter = STATUSES.includes(status) ? { status } : { status: { $ne: 'awaiting_payment' } }

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

// One order — the print page (invoice + packing slip) needs the full document.
router.get(
  '/orders/:id',
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id).populate('customer', 'email name phone').catch(() => null)
    if (!order) throw new HttpError(404, 'Order not found')
    res.json({ order })
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

    const statusChanged = Boolean(status) && status !== order.status
    if (statusChanged) assertTransition(order, status)

    if (courier) order.courier = courier
    if (trackingNumber) order.trackingNumber = trackingNumber

    const nextStatus = status || order.status
    if (TRACKED_STATUSES.includes(nextStatus) && (!order.courier || !order.trackingNumber)) {
      // The customer's tracking page shows both — never let one go out blank.
      throw new HttpError(400, 'Add the courier and tracking number before marking this shipped.')
    }

    if (statusChanged) {
      order.status = status
      order.statusHistory.push({ status, at: new Date(), by: req.customer.email })
    }
    await order.save()

    // Fire and forget — a failed email must not fail the status update.
    if (statusChanged) await notifyStatusChange(order)
    await auditReq(req, statusChanged ? 'order.status' : 'order.update', order.orderNumber, {
      ...(statusChanged ? { status } : {}),
      ...(courier ? { courier } : {}),
      ...(trackingNumber ? { trackingNumber } : {}),
    })

    res.json({ order })
  }),
)

/** The same rules the admin drawer shows, enforced where they cannot be skipped. */
function assertTransition(order, next) {
  const from = order.status
  if (from === 'cancelled') throw new HttpError(400, 'This order is cancelled and cannot be changed.')
  if (next === 'awaiting_payment') throw new HttpError(400, 'An order cannot be moved back to awaiting payment.')
  if (next === 'cancelled') {
    if (from === 'delivered') throw new HttpError(400, 'A delivered order cannot be cancelled.')
    return
  }
  if (from === 'awaiting_payment') {
    throw new HttpError(400, 'This UPI payment was never confirmed. Cancel it, or wait for Razorpay to confirm it.')
  }
  const fromIndex = STATUS_FLOW.indexOf(from)
  const toIndex = STATUS_FLOW.indexOf(next)
  if (toIndex > fromIndex + 1) throw new HttpError(400, 'Move the order forward one step at a time.')
}

// --------------------------------------------------------------- quotes ---
router.get(
  '/quotes',
  asyncHandler(async (req, res) => {
    const status = String(req.query.status || '')
    const filter = QUOTE_STATUSES.includes(status) ? { status } : {}
    const quotes = await Quote.find(filter).populate('customer', 'email name').sort({ createdAt: -1 }).limit(300)
    res.json({
      quotes: quotes.map((q) => ({
        ...toPublicQuote(q),
        customer: q.customer ? { email: q.customer.email, name: q.customer.name || '' } : null,
        price: q.price ?? null,
        quotedAt: q.quotedAt || null,
      })),
    })
  }),
)

const quoteActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('quote'),
    price: z.number().int('Use whole rupees').min(1, 'Enter a price'),
    adminNote: z.string().trim().max(1000).optional().default(''),
    validDays: z.number().int().min(1).max(60).optional().default(SHOP.quoteValidDays),
  }),
  z.object({ action: z.literal('decline'), reason: z.string().trim().min(3, 'Say briefly why').max(500) }),
])

router.patch(
  '/quotes/:id',
  validateBody(quoteActionSchema),
  asyncHandler(async (req, res) => {
    const quote = await Quote.findById(req.params.id).catch(() => null)
    if (!quote) throw new HttpError(404, 'Quote not found')
    if (quote.status === 'paid') throw new HttpError(400, 'This quote is paid — change the order instead.')

    if (req.body.action === 'quote') {
      quote.status = 'quoted'
      quote.price = req.body.price
      quote.adminNote = req.body.adminNote
      quote.quotedAt = new Date()
      quote.validUntil = new Date(Date.now() + req.body.validDays * 86_400_000)
      quote.declineReason = undefined
    } else {
      quote.status = 'declined'
      quote.declineReason = req.body.reason
    }
    await quote.save()
    await enqueue(req.body.action === 'quote' ? 'email.quoteReady' : 'email.quoteDeclined', { quoteId: quote._id.toString() })
    await auditReq(req, `quote.${req.body.action}`, quote.number, req.body.action === 'quote' ? { price: quote.price } : { reason: quote.declineReason })
    res.json({ quote: toPublicQuote(quote) })
  }),
)

// ---------------------------------------------------------- collections ---
router.get(
  '/collections',
  asyncHandler(async (req, res) => {
    const collections = await CollectionModel.find().sort({ order: 1 })
    res.json({ collections: collections.map(toPublicCollection) })
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
    if (!rest.quote && !rest.tiers.length) throw new HttpError(400, 'Add at least one size, or mark it as priced on request.')
    const product = await Product.create({
      ...rest,
      slug: slug || (await uniqueSlugFrom(req.body.name)),
      collection_: collection,
      active: resolveActive(req.body, true),
    })
    await auditReq(req, 'product.create', product.slug)
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

    const before = await Product.findById(req.params.id).lean().catch(() => null)
    const product = await Product.findByIdAndUpdate(req.params.id, patch, { new: true })
    if (!product) throw new HttpError(404, 'Product not found')
    // Price changes are the ones worth being able to trace later.
    const priceChange = JSON.stringify(before?.tiers?.map((t) => t.price)) !== JSON.stringify(product.tiers.map((t) => t.price))
    await auditReq(req, 'product.update', product.slug, {
      fields: Object.keys(patch),
      ...(priceChange ? { pricesBefore: before?.tiers?.map((t) => `${t.id}:${t.price}`), pricesAfter: product.tiers.map((t) => `${t.id}:${t.price}`) } : {}),
    })
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
    await auditReq(req, 'product.delete', product.slug)
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
    const TZ = 'Asia/Kolkata' // the shop's day, not UTC — a 1am IST order belongs to today
    const since = new Date(Date.now() - DAYS * 86_400_000)
    // Counts as revenue: a Razorpay-verified payment, or a live COD order (cash
    // on the doorstep — nothing this app watches get paid). Cancelled orders
    // and unpaid UPI attempts never count.
    const paid = {
      status: { $nin: ['cancelled', 'awaiting_payment'] },
      $or: [{ paymentStatus: 'paid' }, { 'payment.method': 'cod' }],
    }

    const recentCount = await Order.countDocuments({ ...paid, createdAt: { $gte: since } })
    const basis = recentCount > 0 ? { ...paid, createdAt: { $gte: since } } : paid

    const [totals, pending, cod, dayRows, topRows] = await Promise.all([
      Order.aggregate([{ $match: basis }, { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: '$total' } } }]),
      Order.countDocuments({ status: { $in: ['placed', 'confirmed'] } }),
      Order.countDocuments({ ...basis, 'payment.method': { $ne: 'upi' } }),
      Order.aggregate([
        { $match: { ...paid, createdAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TZ } },
            revenue: { $sum: '$total' },
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
      const date = new Date(Date.now() - (DAYS - 1 - i) * 86_400_000).toLocaleDateString('en-CA', { timeZone: TZ })
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
