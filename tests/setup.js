import fs from 'node:fs'
import dotenv from 'dotenv'

// Runs before any app module loads, so config.js sees these values.
// Tests use their own database and never touch real payment, image or mail
// providers — even though .env holds live keys.
const fileEnv = fs.existsSync('.env') ? dotenv.parse(fs.readFileSync('.env')) : {}
const base = process.env.TEST_MONGODB_URI || fileEnv.MONGODB_URI || ''

process.env.NODE_ENV = 'test'
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || base.replace(/\/([^/?]+)(\?|$)/, '/aurie_test$2')
process.env.JWT_SECRET = 'test-secret-not-for-production-0123456789abcdef'
process.env.CORS_ORIGIN = 'http://localhost:5173,http://localhost:5174'
process.env.RAZORPAY_KEY_ID = ''
process.env.RAZORPAY_KEY_SECRET = ''
process.env.RAZORPAY_WEBHOOK_SECRET = 'test-webhook-secret'
process.env.RESEND_API_KEY = ''
process.env.SMTP_HOST = ''
process.env.CLOUDINARY_CLOUD_NAME = ''
process.env.GEMINI_API_KEY = ''

if (!/\/aurie_test(\?|$)/.test(process.env.MONGODB_URI)) {
  throw new Error('Refusing to run tests: MONGODB_URI does not point at an aurie_test database.')
}
