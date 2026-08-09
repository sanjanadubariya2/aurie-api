import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import Customer from '../models/Customer.js'
import { issueOtp, verifyOtp } from '../services/otp.js'
import { sendOtpEmail, sendPhoneOtpFallbackEmail } from '../services/mailer.js'
import { sendOtpSms } from '../services/sms.js'
import { signToken } from '../services/token.js'
import { isSmsLive, isWhatsAppOtpLive } from '../config.js'
import { publicCustomer } from '../lib/serialize.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { validateBody } from '../middleware/validate.js'
import { asyncHandler } from '../middleware/errorHandler.js'

const router = Router()

// Three sends per IP per fifteen minutes, or the SMS/email bill becomes someone
// else's toy. Separate instances for email and phone — sharing one would mean
// checking out (which sends a phone OTP) could lock a customer out of signing
// back in later, since express-rate-limit counts hits per middleware instance.
const makeOtpLimiter = () => rateLimit({ windowMs: 15 * 60_000, max: 3, standardHeaders: true, legacyHeaders: false })
const emailOtpLimiter = makeOtpLimiter()
const phoneOtpLimiter = makeOtpLimiter()

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

    res.json({ token: signToken(customer), customer: publicCustomer(customer) })
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

export default router
