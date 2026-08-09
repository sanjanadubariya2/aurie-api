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
    // Fast2SMS's "Smart OTP" route — the one that supports WhatsApp delivery
    // (with optional SMS fallback) through a single send call. `otpId`
    // identifies which channel/template to use; it's generated in their
    // dashboard's Smart OTP section when you assign an approved WhatsApp
    // template to it, and can't be derived from the API key alone.
    fast2sms: {
      apiKey: process.env.FAST2SMS_API_KEY || '',
      otpId: process.env.FAST2SMS_OTP_ID || '',
    },
  },

  // Meta's WhatsApp Cloud API — a free-tier alternative to MSG91 that skips
  // India's DLT registration wait entirely. Set SMS_PROVIDER=whatsapp to use it.
  whatsappApi: {
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    templateName: process.env.WHATSAPP_TEMPLATE_NAME || 'otp_verification',
    languageCode: process.env.WHATSAPP_TEMPLATE_LANG || 'en_US',
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

export const isWhatsAppOtpLive = Boolean(
  config.sms.provider === 'whatsapp' && config.whatsappApi.accessToken && config.whatsappApi.phoneNumberId,
)
export const isSmsLive = Boolean(
  (config.sms.provider === 'msg91' && config.sms.msg91.authKey) ||
    (config.sms.provider === 'fast2sms' && config.sms.fast2sms.apiKey && config.sms.fast2sms.otpId) ||
    isWhatsAppOtpLive,
)
export const isRazorpayLive = Boolean(config.razorpay.keyId && config.razorpay.keySecret)
export const isCloudinaryLive = Boolean(
  config.cloudinary.cloudName && config.cloudinary.apiKey && config.cloudinary.apiSecret,
)
