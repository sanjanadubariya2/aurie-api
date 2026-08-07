import 'dotenv/config'

const required = (name, fallback) => {
  const v = process.env[name] ?? fallback
  if (v === undefined) throw new Error(`Missing required env var: ${name}`)
  return v
}

export const config = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  mongodbUri: required('MONGODB_URI'),
  jwtSecret: required('JWT_SECRET'),

  email: {
    provider: process.env.EMAIL_PROVIDER || 'resend',
    from: process.env.EMAIL_FROM || 'Aurie <orders@example.com>',
    resendApiKey: process.env.RESEND_API_KEY || '',
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: Number(process.env.SMTP_PORT || 587),
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  },

  sms: {
    provider: process.env.SMS_PROVIDER || '',
    msg91: {
      authKey: process.env.MSG91_AUTH_KEY || '',
      templateId: process.env.MSG91_TEMPLATE_ID || '',
      senderId: process.env.MSG91_SENDER_ID || 'AURIE',
    },
    fast2sms: {
      apiKey: process.env.FAST2SMS_API_KEY || '',
    },
  },

  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  },

  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
    folder: process.env.CLOUDINARY_FOLDER || 'aurie/products',
  },

  whatsapp: process.env.WHATSAPP || '919769469765',
}

export const isSmsLive = Boolean(
  (config.sms.provider === 'msg91' && config.sms.msg91.authKey) ||
    (config.sms.provider === 'fast2sms' && config.sms.fast2sms.apiKey),
)
export const isRazorpayLive = Boolean(config.razorpay.keyId && config.razorpay.keySecret)
export const isCloudinaryLive = Boolean(
  config.cloudinary.cloudName && config.cloudinary.apiKey && config.cloudinary.apiSecret,
)
