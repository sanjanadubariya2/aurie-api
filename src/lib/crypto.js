import crypto from 'node:crypto'
import { config } from '../config.js'

// Derived from JWT_SECRET so there is no extra secret to manage. Rotating
// JWT_SECRET therefore also resets every admin's two-factor setup.
const key = crypto.createHash('sha256').update(`aurie:totp:${config.jwtSecret}`).digest()

export function encrypt(plain) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.')
}

export function decrypt(packed) {
  const [iv, tag, data] = String(packed).split('.').map((s) => Buffer.from(s, 'base64'))
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}
