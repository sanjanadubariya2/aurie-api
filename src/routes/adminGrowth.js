import { Router } from 'express'
import multer from 'multer'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import Coupon from '../models/Coupon.js'
import Review from '../models/Review.js'
import Order from '../models/Order.js'
import Quote from '../models/Quote.js'
import Material from '../models/Material.js'
import { requireOwner } from '../middleware/requireAdmin.js'
import { validateBody } from '../middleware/validate.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { HttpError } from '../lib/HttpError.js'
import { auditReq } from '../lib/audit.js'
import { refreshProductRating } from '../lib/reviews.js'
import { generateJson } from '../services/ai.js'
import { STATUS_FLOW } from '../models/Order.js'

/** Coupons, review moderation and the admin AI helpers. Mounted inside the admin router. */
const router = Router()

// --------------------------------------------------------------- coupons ---
const couponSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{3,20}$/, 'Codes are 3–20 letters, numbers or hyphens'),
  description: z.string().trim().max(120).optional().default(''),
  type: z.enum(['percent', 'flat']),
  value: z.number().int().min(1),
  maxDiscount: z.number().int().min(1).optional().nullable(),
  minSubtotal: z.number().int().min(0).optional().default(0),
  collection: z.string().trim().optional().nullable(),
  firstOrderOnly: z.boolean().optional().default(false),
  usageLimit: z.number().int().min(1).optional().nullable(),
  perCustomerLimit: z.number().int().min(1).optional().default(1),
  startsAt: z.coerce.date().optional().nullable(),
  endsAt: z.coerce.date().optional().nullable(),
  active: z.boolean().optional().default(true),
})
const checkPercent = (b) => {
  if (b.type === 'percent' && b.value > 90) throw new HttpError(400, 'Percent codes top out at 90%.')
}

router.get(
  '/coupons',
  requireOwner,
  asyncHandler(async (req, res) => res.json({ coupons: await Coupon.find().sort({ createdAt: -1 }) })),
)
router.post(
  '/coupons',
  requireOwner,
  validateBody(couponSchema),
  asyncHandler(async (req, res) => {
    checkPercent(req.body)
    const coupon = await Coupon.create(req.body)
    await auditReq(req, 'coupon.create', coupon.code, { type: coupon.type, value: coupon.value })
    res.status(201).json({ coupon })
  }),
)
router.patch(
  '/coupons/:id',
  requireOwner,
  validateBody(couponSchema.partial()),
  asyncHandler(async (req, res) => {
    if (req.body.type || req.body.value) checkPercent({ type: req.body.type || 'flat', value: req.body.value || 0 })
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, req.body, { new: true }).catch(() => null)
    if (!coupon) throw new HttpError(404, 'Coupon not found')
    await auditReq(req, 'coupon.update', coupon.code, req.body)
    res.json({ coupon })
  }),
)

// --------------------------------------------------------------- reviews ---
router.get(
  '/reviews',
  asyncHandler(async (req, res) => {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending'
    const reviews = await Review.find({ status }).populate('customer', 'email').populate('order', 'orderNumber').sort({ createdAt: -1 }).limit(200)
    res.json({ reviews })
  }),
)
router.patch(
  '/reviews/:id',
  validateBody(z.object({ status: z.enum(['approved', 'rejected']) })),
  asyncHandler(async (req, res) => {
    const review = await Review.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true }).catch(() => null)
    if (!review) throw new HttpError(404, 'Review not found')
    await refreshProductRating(review.product)
    await auditReq(req, `review.${req.body.status}`, review.product, { rating: review.rating })
    res.json({ review })
  }),
)

// -------------------------------------------------------------- AI tools ---
// The owner's helpers. Every output is a draft shown for editing — nothing is
// sent or saved without a person clicking save.
const aiLimiter = rateLimit({ windowMs: 60 * 60_000, max: 60, standardHeaders: true, legacyHeaders: false })
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } })
const VOICE =
  "You write for Aurie, a Mumbai studio hand-pouring sculptural candles to order. Voice: warm, specific, unfussy, British-Indian English; " +
  'short sentences; no exclamation marks; never claim things you cannot see (no organic/eco claims).'

/** Photo (+ optional name) -> name, scent idea, description, badge. */
router.post(
  '/ai/describe-product',
  aiLimiter,
  imageUpload.single('image'),
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').slice(0, 80)
    let image
    if (req.file) image = { mimeType: req.file.mimetype, data: req.file.buffer.toString('base64') }
    else if (req.body?.imageUrl && /^https:\/\/res\.cloudinary\.com\//.test(req.body.imageUrl)) {
      const r = await fetch(req.body.imageUrl.replace('/f_auto,', '/f_jpg,'))
      if (r.ok) image = { mimeType: 'image/jpeg', data: Buffer.from(await r.arrayBuffer()).toString('base64') }
    }
    if (!image && !name) throw new HttpError(400, 'Give a photo or at least a name.')
    const out = await generateJson({
      system: `${VOICE} Write catalogue copy for one candle. Return JSON {"name", "scent", "blurb" (2 sentences, max 35 words, what it looks like and one detail that makes it special), "badge" (2–3 words or empty)}.`,
      prompt: `Working name: ${name || 'none'}`,
      images: image ? [image] : [],
      schema: {
        type: 'OBJECT',
        properties: { name: { type: 'STRING' }, scent: { type: 'STRING' }, blurb: { type: 'STRING' }, badge: { type: 'STRING' } },
        required: ['name', 'blurb'],
      },
      temperature: 0.7,
    })
    res.json({
      name: String(out.name || name).slice(0, 80),
      scent: String(out.scent || '').slice(0, 60),
      blurb: String(out.blurb || '').slice(0, 400),
      badge: String(out.badge || '').slice(0, 30),
    })
  }),
)

/** Order + what you want to say -> a reply draft for WhatsApp or email. */
router.post(
  '/ai/reply-draft',
  aiLimiter,
  validateBody(z.object({ orderId: z.string(), intent: z.string().trim().min(3).max(300), channel: z.enum(['whatsapp', 'email']).default('whatsapp') })),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.body.orderId).catch(() => null)
    if (!order) throw new HttpError(404, 'Order not found')
    const facts = {
      order: order.orderNumber,
      firstName: (order.address?.fullName || '').split(' ')[0],
      items: order.items.map((l) => `${l.name} (${l.tierLabel}) x${l.count}${l.note ? ` — ${l.note}` : ''}`),
      status: order.status,
      expectedBy: order.expectedBy?.toDateString(),
      neededBy: order.neededBy?.toDateString() || null,
      courier: order.courier || null,
      tracking: order.trackingNumber || null,
    }
    const out = await generateJson({
      system: `${VOICE} Draft a ${req.body.channel === 'whatsapp' ? 'WhatsApp message (under 70 words, no subject)' : 'short email (under 120 words, include a subject)'} from the shop to a customer. Use only the facts given; do not promise refunds, discounts or dates unless the owner's note says so. Return JSON {"subject", "message"}.`,
      prompt: `Facts: ${JSON.stringify(facts)}\nWhat the owner wants to say: ${req.body.intent}`,
      schema: { type: 'OBJECT', properties: { subject: { type: 'STRING' }, message: { type: 'STRING' } }, required: ['message'] },
      temperature: 0.5,
    })
    res.json({ subject: String(out.subject || '').slice(0, 120), message: String(out.message || '').slice(0, 1200) })
  }),
)

/** A spoken packing-table note -> structured order update for the owner to confirm. */
router.post(
  '/ai/parse-update',
  aiLimiter,
  validateBody(z.object({ transcript: z.string().trim().min(3).max(500) })),
  asyncHandler(async (req, res) => {
    const out = await generateJson({
      system:
        'Turn a spoken note about one candle order into JSON {"orderNumber" (like AUR123456, digits only after AUR, or empty), "status" (one of ' +
        `${STATUS_FLOW.join(', ')}, cancelled, or empty), "courier" (Delhivery, Shiprocket, Bluedart, DTDC, India Post, Other, or empty), "trackingNumber" (letters/digits only, or empty)}. ` +
        'Spoken digits may be words ("four five") — convert them. Never guess; leave a field empty if it was not said.',
      prompt: req.body.transcript,
      schema: {
        type: 'OBJECT',
        properties: { orderNumber: { type: 'STRING' }, status: { type: 'STRING' }, courier: { type: 'STRING' }, trackingNumber: { type: 'STRING' } },
      },
      temperature: 0,
    })
    const orderNumber = /^AUR\d{6}$/i.test(String(out.orderNumber || '').replace(/\s/g, '')) ? String(out.orderNumber).replace(/\s/g, '').toUpperCase() : ''
    res.json({
      orderNumber,
      status: [...STATUS_FLOW, 'cancelled'].includes(out.status) ? out.status : '',
      courier: ['Delhivery', 'Shiprocket', 'Bluedart', 'DTDC', 'India Post', 'Other'].includes(out.courier) ? out.courier : '',
      trackingNumber: String(out.trackingNumber || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40),
    })
  }),
)

/** Plain-words weekly summary built from real numbers (the model only phrases them). */
router.get(
  '/ai/weekly-summary',
  requireOwner,
  aiLimiter,
  asyncHandler(async (req, res) => {
    const since = new Date(Date.now() - 7 * 86_400_000)
    const prev = new Date(Date.now() - 14 * 86_400_000)
    const sold = { status: { $nin: ['cancelled', 'awaiting_payment'] } }
    const [thisWeek, lastWeek, lateOrders, newQuotes, lowMaterials, cancelled, top] = await Promise.all([
      Order.aggregate([{ $match: { ...sold, createdAt: { $gte: since } } }, { $group: { _id: null, n: { $sum: 1 }, revenue: { $sum: '$total' } } }]),
      Order.aggregate([{ $match: { ...sold, createdAt: { $gte: prev, $lt: since } } }, { $group: { _id: null, n: { $sum: 1 }, revenue: { $sum: '$total' } } }]),
      Order.countDocuments({ status: { $in: ['placed', 'confirmed'] }, expectedBy: { $lt: new Date() } }),
      Quote.countDocuments({ status: 'new' }),
      Material.find({ $expr: { $lte: ['$onHand', '$lowAt'] } }, { name: 1 }),
      Order.countDocuments({ status: 'cancelled', updatedAt: { $gte: since } }),
      Order.aggregate([
        { $match: { ...sold, createdAt: { $gte: since } } },
        { $unwind: '$items' },
        { $group: { _id: '$items.name', units: { $sum: '$items.count' } } },
        { $sort: { units: -1 } },
        { $limit: 3 },
      ]),
    ])
    const facts = {
      ordersThisWeek: thisWeek[0]?.n || 0,
      revenueThisWeek: thisWeek[0]?.revenue || 0,
      ordersLastWeek: lastWeek[0]?.n || 0,
      revenueLastWeek: lastWeek[0]?.revenue || 0,
      ordersPastPromisedDate: lateOrders,
      customRequestsWaiting: newQuotes,
      materialsLow: lowMaterials.map((m) => m.name),
      cancelledThisWeek: cancelled,
      bestSellers: top.map((t) => `${t._id} (${t.units})`),
    }
    const out = await generateJson({
      system: `${VOICE} Summarise the week for the shop owner in 3–5 short bullet points, most important first (late orders and waiting requests before good news). Use ₹ and the exact numbers given — never invent one. Return JSON {"bullets": [strings]}.`,
      prompt: JSON.stringify(facts),
      schema: { type: 'OBJECT', properties: { bullets: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['bullets'] },
      temperature: 0.3,
    })
    res.json({ bullets: (out.bullets || []).slice(0, 6).map((b) => String(b).slice(0, 240)), facts })
  }),
)

export default router
