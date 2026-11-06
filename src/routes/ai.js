import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import multer from 'multer'
import Product from '../models/Product.js'
import { HttpError } from '../lib/HttpError.js'
import { generateJson } from '../services/ai.js'
import { SHOP } from '../lib/settings.js'
import { validateBody } from '../middleware/validate.js'
import { asyncHandler } from '../middleware/errorHandler.js'

/**
 * AI helpers for the storefront. Public (no sign-in needed to try them) but
 * rate-limited per IP, and every output is checked here before it is sent —
 * the model is never trusted to respect a length limit or stay on topic.
 */
const router = Router()
router.use(rateLimit({ windowMs: 15 * 60_000, max: 20, standardHeaders: true, legacyHeaders: false, message: { message: 'That is a lot of ideas! Give it a few minutes.' } }))

const text = (max) => z.string().trim().max(max).optional().default('')

// ------------------------------------------------- Secret Glow wording ---
const secretSchema = z.object({
  occasion: text(60),
  recipient: text(60),
  tone: z.enum(['sweet', 'funny', 'romantic', 'heartfelt', 'cheeky', 'celebratory']).optional().default('sweet'),
  idea: text(200),
  language: z.enum(['English', 'Hinglish', 'Hindi']).optional().default('English'),
})

router.post(
  '/secret-message',
  validateBody(secretSchema),
  asyncHandler(async (req, res) => {
    const max = SHOP.secretMessageMaxChars
    const { occasion, recipient, tone, idea, language } = req.body
    const out = await generateJson({
      system:
        `You write the hidden message for a "Secret Glow" candle: letter beads set under the wax that appear once it melts. ` +
        `Hard limit: ${max} characters INCLUDING spaces and punctuation — the beads physically cannot hold more. ` +
        `Write in ${language === 'Hindi' ? 'Hindi written in Latin letters (letter beads are Latin only)' : language}. ` +
        `Use plain letters, digits, spaces and at most one of ! ? ♥ — no other emoji. Never offensive, never about self-harm. ` +
        `Return JSON: {"suggestions": [5 different messages]}.`,
      prompt: `Occasion: ${occasion || 'not given'}\nFor: ${recipient || 'not given'}\nTone: ${tone}\nTheir idea: ${idea || 'none'}`,
      schema: {
        type: 'OBJECT',
        properties: { suggestions: { type: 'ARRAY', items: { type: 'STRING' } } },
        required: ['suggestions'],
      },
    })

    const suggestions = [...new Set((out.suggestions || []).map((s) => String(s).replace(/\s+/g, ' ').trim()))]
      .filter((s) => s.length > 0 && [...s].length <= max)
      .slice(0, 5)
    res.json({ suggestions, maxChars: max })
  }),
)

// --------------------------------------------------------- gift finder ---
/** A compact catalogue the model can choose from — never invent a product. */
async function catalogueForAi() {
  const products = await Product.find({ active: true }).limit(200)
  return products.map((p) => {
    const prices = (p.tiers || []).map((t) => t.price)
    return {
      id: p.slug,
      name: p.name,
      collection: p.collection_,
      price: p.quote ? 'custom quote' : prices.length ? `₹${Math.min(...prices)}${prices.length > 1 ? `–${Math.max(...prices)}` : ''}` : '',
      scent: p.scent || '',
      about: (p.blurb || '').slice(0, 140),
    }
  })
}

const picksSchema = {
  type: 'OBJECT',
  properties: {
    intro: { type: 'STRING' },
    picks: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, reason: { type: 'STRING' } }, required: ['id', 'reason'] },
    },
  },
  required: ['picks'],
}

/** Keeps only real, active products, at most four, each with a short reason. */
function cleanPicks(out, catalogue) {
  const ids = new Set(catalogue.map((p) => p.id))
  const seen = new Set()
  return (out.picks || [])
    .filter((p) => ids.has(p.id) && !seen.has(p.id) && seen.add(p.id))
    .slice(0, 4)
    .map((p) => ({ id: p.id, reason: String(p.reason || '').slice(0, 200) }))
}

const SHOP_VOICE =
  'You are the gift adviser for Aurie, a small Mumbai studio that hand-pours sculptural candles to order (about 7 days). ' +
  'Warm, brief, practical. Only recommend products from the catalogue JSON you are given, by their exact id. ' +
  'Respect the budget. Prefer "custom quote" products when the request needs a message, a name or a hamper.'

router.post(
  '/gift-finder',
  validateBody(z.object({ query: z.string().trim().min(3, 'Tell us a little about the gift').max(400) })),
  asyncHandler(async (req, res) => {
    const catalogue = await catalogueForAi()
    const out = await generateJson({
      system: `${SHOP_VOICE} Return JSON: {"intro": one sentence, "picks": [up to 4 {"id", "reason" (max 20 words, why it suits this person)}]}.`,
      prompt: `Catalogue: ${JSON.stringify(catalogue)}\n\nCustomer: ${req.body.query}`,
      schema: picksSchema,
      temperature: 0.6,
    })
    res.json({ intro: String(out.intro || '').slice(0, 240), picks: cleanPicks(out, catalogue) })
  }),
)

// ------------------------------------------------------ photo matching ---
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    /^image\/(jpeg|png|webp)$/.test(file.mimetype) ? cb(null, true) : cb(new HttpError(400, 'Use a JPG, PNG or WebP photo.')),
})

/**
 * "Send us a reference": the customer uploads a photo (a cake, a flower, a
 * Pinterest pin). The model describes it, picks the closest catalogue pieces,
 * and drafts a brief the customer can send as a custom request.
 */
router.post(
  '/match-photo',
  photoUpload.single('photo'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Attach a photo.')
    const catalogue = await catalogueForAi()
    const out = await generateJson({
      system:
        `${SHOP_VOICE} You are shown a customer's reference photo. ` +
        'Return JSON: {"description": what you see in one sentence, "picks": up to 3 {"id", "reason"} closest catalogue items, ' +
        '"brief": a 2–3 sentence request the customer could send to have a candle made like this (shape, colours, size, finish)}. ' +
        'If the photo is not something that could inspire a candle, say so in description and return no picks.',
      prompt: `Catalogue: ${JSON.stringify(catalogue)}`,
      images: [{ mimeType: req.file.mimetype, data: req.file.buffer.toString('base64') }],
      schema: {
        type: 'OBJECT',
        properties: { description: { type: 'STRING' }, brief: { type: 'STRING' }, picks: picksSchema.properties.picks },
        required: ['description', 'picks'],
      },
      temperature: 0.4,
    })
    res.json({
      description: String(out.description || '').slice(0, 300),
      brief: String(out.brief || '').slice(0, 600),
      picks: cleanPicks(out, catalogue).slice(0, 3),
    })
  }),
)

export default router
