import { config } from '../config.js'

async function sendViaMsg91(phone, code) {
  const url = new URL('https://control.msg91.com/api/v5/otp')
  url.searchParams.set('otp', code)
  url.searchParams.set('mobile', `91${phone}`)
  url.searchParams.set('template_id', config.sms.msg91.templateId)
  url.searchParams.set('sender', config.sms.msg91.senderId)
  const res = await fetch(url, { headers: { authkey: config.sms.msg91.authKey } })
  if (!res.ok) throw new Error(`MSG91 request failed (${res.status})`)
}

/** Fast2SMS's "Smart OTP" endpoint — delivers over WhatsApp (with optional
 *  SMS fallback, configured on their `otp_id`'s dashboard entry, not here).
 *  Passing our own `otp` means Fast2SMS never generates or holds the code —
 *  it's purely a delivery transport, same as every other provider in this
 *  file. Our own bcrypt-hashed copy in Mongo is still the source of truth
 *  that /auth/phone/verify checks against. */
async function sendViaFast2Sms(phone, code) {
  const res = await fetch('https://www.fast2sms.com/dev/otp/send', {
    method: 'POST',
    headers: { Authorization: config.sms.fast2sms.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mobile: phone,
      otp_id: config.sms.fast2sms.otpId,
      otp: code,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.return === false) {
    throw new Error(`Fast2SMS request failed (${res.status}): ${data.message || 'unknown error'}`)
  }
}

/** Sends the code as a WhatsApp template message via Meta's Cloud API. Only
 *  template messages can reach someone who hasn't messaged the business first
 *  — that's WhatsApp's anti-spam rule, and it's exactly the OTP situation, so
 *  the "Authentication" template category exists specifically for this. */
async function sendViaWhatsApp(phone, code) {
  const url = `https://graph.facebook.com/v21.0/${config.whatsappApi.phoneNumberId}/messages`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsappApi.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: `91${phone}`,
      type: 'template',
      template: {
        name: config.whatsappApi.templateName,
        language: { code: config.whatsappApi.languageCode },
        components: [{ type: 'body', parameters: [{ type: 'text', text: code }] }],
      },
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`WhatsApp request failed (${res.status}): ${body}`)
  }
}

/** Sends a 6-digit OTP by phone — WhatsApp, SMS, whichever SMS_PROVIDER names.
 *  Logs to the console instead of throwing when no provider is configured, so
 *  DLT/template approval delays never block local dev. */
export async function sendOtpSms(phone, code) {
  if (config.sms.provider === 'whatsapp' && config.whatsappApi.accessToken) return sendViaWhatsApp(phone, code)
  if (config.sms.provider === 'msg91' && config.sms.msg91.authKey) return sendViaMsg91(phone, code)
  if (config.sms.provider === 'fast2sms' && config.sms.fast2sms.apiKey && config.sms.fast2sms.otpId) {
    return sendViaFast2Sms(phone, code)
  }
  console.log(`[sms:dev] to=+91${phone} code=${code}`)
}
