import { Router } from 'express'
import crypto from 'node:crypto'
import multer from 'multer'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import Quote, { toPublicQuote } from '../models/Quote.js'
import Product from '../models/Product.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { validateBody } from '../middleware/validate.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { HttpError } from '../lib/HttpError.js'
import { SHOP } from '../lib/settings.js'
import { earliestDeliveryDate } from '../lib/createOrder.js'
import { uploadImage } from '../services/cloudinary.js'
import { isCloudinaryLive } from '../config.js'
import { enqueue } from '../jobs/queue.js'

/**
 * Backend contract (all need a customer session)
 *   POST /quotes        multipart: fields below + up to 3 `images` -> { quote }
 *   GET  /quotes                                                     -> { quotes }
 *   GET  /quotes/:id                                                 -> { quote }
 * Paying a quote: POST /payments/quote/:id (routes/payments.js).
 */
const router = Router()
router.use(requireAuth)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: SHOP.maxQuoteImages },
  fileFilter: (req, file, cb) =>
    /^image\/(jpeg|png|webp|heic|heif)$/.test(file.mimetype)
      ? cb(null, true)
      : cb(new HttpError(400, 'Photos must be JPG, PNG, WebP or HEIC.')),
})

// Requests are real work for a person — a gentle cap stops floods.
const createLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 10,
  keyGenerator: (req) => `quote:${req.customer._id}`,
  message: { message: 'You have sent a lot of requests — we will get back to you on those first.' },
})

const optionalText = (max) => z.string().trim().max(max).optional().default('')

const quoteSchema = z.object({
  productId: optionalText(80),
  occasion: optionalText(80),
  budget: optionalText(40),
  message: z
    .string()
    .trim()
    .max(SHOP.secretMessageMaxChars, `The hidden message can be at most ${SHOP.secretMessageMaxChars} characters`)
    .optional()
    .default(''),
  details: z.string().trim().min(10, 'Tell us a little more — at least a sentence about what you would like').max(2000),
  neededBy: z
    .string()
    .trim()
    .optional()
    .default('')
    .refine((v) => !v || (/^\d{4}-\d{2}-\d{2}$/.test(v) && v >= earliestDeliveryDate()), {
      message: `Custom pieces need at least ${SHOP.leadTimeDays} days — pick a later date`,
    }),
})

async function quoteNumber() {
  for (let i = 0; i < 8; i++) {
    const n = `Q${crypto.randomInt(100000, 1_000_000)}`
     
    if (!(await Quote.exists({ number: n }))) return n
  }
  throw new Error('Could not generate a quote number')
}

router.post(
  '/',
  createLimiter,
  upload.array('images', SHOP.maxQuoteImages),
  validateBody(quoteSchema),
  asyncHandler(async (req, res) => {
    const { productId, occasion, budget, message, details, neededBy } = req.body
    const product = productId ? await Product.findOne({ slug: productId }) : null

    // Photos are optional; if Cloudinary is off we still take the request.
    const images = []
    if (req.files?.length) {
      if (!isCloudinaryLive) throw new HttpError(503, 'Photo uploads are not available right now — send the request without them.')
      for (const file of req.files) {
         
        const { secure_url: url, public_id: publicId } = await uploadImage(file.buffer, 'aurie/quotes')
        images.push({ url, publicId })
      }
    }

    const quote = await Quote.create({
      number: await quoteNumber(),
      customer: req.customer._id,
      productId: product?.slug,
      productName: product?.name,
      occasion,
      budget,
      message,
      details,
      neededBy: neededBy ? new Date(`${neededBy}T00:00:00+05:30`) : undefined,
      images,
    })
    await enqueue('email.quoteReceived', { quoteId: quote._id.toString() })
    res.status(201).json({ quote: toPublicQuote(quote) })
  }),
)

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const quotes = await Quote.find({ customer: req.customer._id }).sort({ createdAt: -1 }).limit(50)
    res.json({ quotes: quotes.map(toPublicQuote) })
  }),
)

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const quote = await Quote.findOne({ _id: req.params.id, customer: req.customer._id }).catch(() => null)
    if (!quote) throw new HttpError(404, 'Quote not found')
    res.json({ quote: toPublicQuote(quote) })
  }),
)

export default router
