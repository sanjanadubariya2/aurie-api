import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import Customer from '../models/Customer.js'
import { issueOtp, verifyOtp } from '../services/otp.js'
import { sendOtpEmail, sendPhoneOtpFallbackEmail } from '../services/mailer.js'
import { sendOtpSms } from '../services/sms.js'
import { startSession, endSession } from '../lib/session.js'
import { isSmsLive, isWhatsAppOtpLive } from '../config.js'
import { publicCustomer } from '../lib/serialize.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { validateBody } from '../middleware/validate.js'
import { asyncHandler } from '../middleware/errorHandler.js'

const router = Router()

// Two layers of limits on sending codes:
//  - per IP, loose: Indian mobile carriers put many customers behind one
//    shared IP (CGNAT), so a tight per-IP cap locks out strangers.
//  - per email/phone, tight: this is what actually stops someone flooding one
//    inbox or brute-forcing by requesting fresh codes from many IPs.
// Separate instances for email and phone — express-rate-limit counts hits per
// middleware instance, and checkout must never use up the sign-in allowance.
const limitOpts = { standardHeaders: true, legacyHeaders: false }
const tooMany = (what) => ({ message: `Too many codes requested for this ${what}. Wait a few minutes and try again.` })
const ipOtpLimiter = () => rateLimit({ ...limitOpts, windowMs: 15 * 60_000, max: 20 })
const identifierLimiter = (field) =>
  rateLimit({
    ...limitOpts,
    windowMs: 60 * 60_000,
    max: 5,
    keyGenerator: (req) => `${field}:${String(req.body?.[field] || '').toLowerCase().trim()}`,
    message: tooMany(field === 'email' ? 'email' : 'number'),
  })
const emailOtpLimiter = [ipOtpLimiter(), identifierLimiter('email')]
const phoneOtpLimiter = [ipOtpLimiter(), identifierLimiter('phone')]
// Wrong guesses: 5 per code (services/otp.js), and at most 15 verify calls per
// IP per 15 minutes so a fresh-code-per-5-guesses loop stays slow.
const verifyLimiter = rateLimit({ ...limitOpts, windowMs: 15 * 60_000, max: 15 })

const emailSchema = z.object({ email: z.string().trim().toLowerCase().email('Enter a valid email address') })
const emailVerifySchema = emailSchema.extend({ code: z.string().trim().length(6, 'Enter the 6-digit code') })

const phoneSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(/^[6-9]\d{9}$/, 'Enter a 10-digit Indian mobile number'),
})
const phoneVerifySchema = phoneSchema.extend({ code: z.string().trim().length(6, 'Enter the 6-digit code') })

router.post(
  '/email/otp',
  emailOtpLimiter,
  validateBody(emailSchema),
  asyncHandler(async (req, res) => {
    const { email } = req.body
    const code = await issueOtp(email, 'email')
    await sendOtpEmail(email, code)
    res.json({ sent: true }) // identical response whether or not the account exists
  }),
)

router.post(
  '/email/verify',
  verifyLimiter,
  validateBody(emailVerifySchema),
  asyncHandler(async (req, res) => {
    const { email, code } = req.body
    await verifyOtp(email, 'email', code)

    // First verified sign-in creates the account. There is no separate signup flow.
    const customer = await Customer.findOneAndUpdate(
      { email },
      { $setOnInsert: { email, role: 'customer' } },
      { upsert: true, new: true },
    )

    const token = startSession(res, customer, 'customer')
    res.json({ token, customer: publicCustomer(customer) })
  }),
)

router.post(
  '/phone/otp',
  requireAuth,
  phoneOtpLimiter,
  validateBody(phoneSchema),
  asyncHandler(async (req, res) => {
    const { phone } = req.body
    const code = await issueOtp(phone, 'sms')
    // No SMS/WhatsApp provider configured yet — the code still has to reach
    // the customer somewhere, so it goes to their (already-verified) email
    // instead of only a server console nobody but a developer can see.
    // Switches to real delivery automatically the moment SMS_PROVIDER is set.
    let channel = 'email'
    if (isWhatsAppOtpLive) {
      await sendOtpSms(phone, code)
      channel = 'whatsapp'
    } else if (isSmsLive) {
      await sendOtpSms(phone, code)
      channel = 'sms'
    } else {
      await sendPhoneOtpFallbackEmail(req.customer.email, phone, code)
    }
    res.json({ sent: true, channel })
  }),
)

router.post(
  '/phone/verify',
  requireAuth,
  verifyLimiter,
  validateBody(phoneVerifySchema),
  asyncHandler(async (req, res) => {
    const { phone, code } = req.body
    await verifyOtp(phone, 'sms', code)

    req.customer.phone = phone
    req.customer.phoneVerified = true
    await req.customer.save()

    res.json({ verified: true })
  }),
)

router.get('/me', requireAuth, (req, res) => {
  res.json({ customer: publicCustomer(req.customer) })
})

/** Ends this browser's session. Always succeeds, signed in or not. */
router.post('/logout', (req, res) => {
  endSession(res, 'customer')
  res.json({ ok: true })
})

/** Signs out every device: bumps tokenVersion so all issued tokens die. */
router.post(
  '/logout-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    req.customer.tokenVersion = (req.customer.tokenVersion || 0) + 1
    await req.customer.save()
    endSession(res, 'customer')
    res.json({ ok: true })
  }),
)

export default router
