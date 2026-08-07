import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import Otp from '../models/Otp.js'
import { HttpError } from '../lib/HttpError.js'

const TTL_MINUTES = 10
const MAX_ATTEMPTS = 5

export async function issueOtp(identifier, channel) {
  // crypto.randomInt, not Math.random — this is a credential
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')

  // One live code at a time, written atomically — two near-simultaneous requests
  // for the same identifier (a double-tapped resend, a duplicated dev-mode
  // effect) must not interleave into a delete-then-create race where the code
  // actually left in the database isn't the one that was just sent.
  await Otp.findOneAndUpdate(
    { identifier, channel },
    { codeHash: await bcrypt.hash(code, 10), attempts: 0, expiresAt: new Date(Date.now() + TTL_MINUTES * 60_000) },
    { upsert: true },
  )

  return code // hand to the mailer/SMS service — never to the HTTP response
}

export async function verifyOtp(identifier, channel, code) {
  const record = await Otp.findOne({ identifier, channel })
  if (!record) throw new HttpError(400, 'That code has expired. Ask for a new one.')

  if (record.attempts >= MAX_ATTEMPTS) {
    await record.deleteOne()
    throw new HttpError(429, 'Too many tries. Ask for a new code.')
  }

  const ok = await bcrypt.compare(String(code || ''), record.codeHash)
  if (!ok) {
    record.attempts += 1
    await record.save()
    throw new HttpError(400, 'That code did not match. Ask for a new one.')
  }

  await record.deleteOne() // single use
  return true
}
