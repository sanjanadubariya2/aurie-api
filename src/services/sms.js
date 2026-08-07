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

async function sendViaFast2Sms(phone, code) {
  const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
    method: 'POST',
    headers: { authorization: config.sms.fast2sms.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      route: 'otp',
      variables_values: code,
      numbers: phone,
    }),
  })
  if (!res.ok) throw new Error(`Fast2SMS request failed (${res.status})`)
}

/** Sends a 6-digit OTP by SMS. Logs to the console instead of throwing when no
 *  provider is configured — DLT template approval takes days, dev shouldn't wait on it. */
export async function sendOtpSms(phone, code) {
  if (config.sms.provider === 'msg91' && config.sms.msg91.authKey) return sendViaMsg91(phone, code)
  if (config.sms.provider === 'fast2sms' && config.sms.fast2sms.apiKey) return sendViaFast2Sms(phone, code)
  console.log(`[sms:dev] to=+91${phone} code=${code}`)
}
