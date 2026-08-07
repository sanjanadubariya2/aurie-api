import { config } from '../config.js'

const configured = () =>
  config.email.provider === 'resend' ? Boolean(config.email.resendApiKey) : Boolean(config.email.smtp.host)

let resendClient
async function sendViaResend({ to, subject, html }) {
  if (!resendClient) {
    const { Resend } = await import('resend')
    resendClient = new Resend(config.email.resendApiKey)
  }
  await resendClient.emails.send({ from: config.email.from, to, subject, html })
}

let smtpTransport
async function sendViaSmtp({ to, subject, html }) {
  if (!smtpTransport) {
    const nodemailer = await import('nodemailer')
    smtpTransport = nodemailer.default.createTransport({
      host: config.email.smtp.host,
      port: config.email.smtp.port,
      secure: config.email.smtp.port === 465,
      auth: { user: config.email.smtp.user, pass: config.email.smtp.pass },
    })
  }
  await smtpTransport.sendMail({ from: config.email.from, to, subject, html })
}

/** Sends `{ to, subject, html }`. Logs to the console instead of throwing when no
 *  provider is configured, so local dev works before any account exists. */
export async function sendEmail(message) {
  if (!configured()) {
    console.log(`[mailer:dev] to=${message.to} subject="${message.subject}"\n${message.html}`)
    return
  }
  if (config.email.provider === 'resend') return sendViaResend(message)
  return sendViaSmtp(message)
}

// Once real delivery is configured, sendEmail() no longer logs the code
// anywhere — it's actually sent. Echo it to the console outside production
// too, so local dev/QA doesn't mean digging through an inbox for every OTP.
const logOtpOutsideProd = (channel, to, code) => {
  if (!config.isProd) console.log(`[otp:${channel}] to=${to} code=${code}`)
}

export async function sendOtpEmail(email, code) {
  logOtpOutsideProd('email', email, code)
  await sendEmail({
    to: email,
    subject: `${code} is your Aurie sign-in code`,
    html: `<p>Your code is <strong style="font-size:20px">${code}</strong>. It expires in 10 minutes.</p>`,
  })
}

/** Used while no SMS provider is configured — the code still has to reach the
 *  customer somewhere, and their inbox is the one channel already live. */
export async function sendPhoneOtpFallbackEmail(email, phone, code) {
  logOtpOutsideProd('phone-via-email', email, code)
  await sendEmail({
    to: email,
    subject: `${code} is your Aurie phone verification code`,
    html: `<p>SMS delivery isn't set up yet, so here's your code for <strong>+91 ${phone}</strong> by email instead: <strong style="font-size:20px">${code}</strong>. It expires in 10 minutes.</p>`,
  })
}

export async function sendOrderStatusEmail(email, order) {
  await sendEmail({
    to: email,
    subject: `Order ${order.orderNumber} — ${order.status.replace(/_/g, ' ')}`,
    html: `<p>Your order <strong>${order.orderNumber}</strong> is now <strong>${order.status.replace(/_/g, ' ')}</strong>.</p>${
      order.trackingNumber ? `<p>Tracking: ${order.courier} · ${order.trackingNumber}</p>` : ''
    }`,
  })
}
