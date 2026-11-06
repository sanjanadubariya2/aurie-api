import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
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

export default router
