import { config } from '../config.js'

/**
 * Email goes out through Resend or SMTP (EMAIL_PROVIDER picks the primary).
 * If both are configured and the primary fails, the other one is tried before
 * giving up — a Resend outage or a Gmail daily cap should not stop customers
 * signing in. With neither configured, messages are printed to the console so
 * local development works without any account.
 */

const resendReady = () => Boolean(config.email.resendApiKey)
const smtpReady = () => Boolean(config.email.smtp.host && config.email.smtp.user && config.email.smtp.pass)

let resendClient
async function sendViaResend({ to, subject, html, text }) {
  if (!resendClient) {
    const { Resend } = await import('resend')
    resendClient = new Resend(config.email.resendApiKey)
  }
  // The Resend SDK does not throw on an API-level rejection (unverified
  // domain, invalid from-address, etc.) — it resolves with { data, error }.
  const { error } = await resendClient.emails.send({ from: config.email.from, to, subject, html, text })
  if (error) throw new Error(`Resend rejected the email: ${error.message || JSON.stringify(error)}`)
}

let smtpTransport
async function sendViaSmtp({ to, subject, html, text }) {
  if (!smtpTransport) {
    const nodemailer = await import('nodemailer')
    smtpTransport = nodemailer.default.createTransport({
      host: config.email.smtp.host,
      port: config.email.smtp.port,
      secure: config.email.smtp.port === 465,
      auth: { user: config.email.smtp.user, pass: config.email.smtp.pass },
      // Some hosts silently drop outbound SMTP instead of refusing it, which
      // without a timeout hangs the request (and the OTP endpoint) forever.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    })
  }
  await smtpTransport.sendMail({ from: smtpFrom(), to, subject, html, text })
}

/** Gmail and most SMTP hosts only deliver mail "from" the account you log in
 *  with — anything else is rewritten or lands in spam. Keep the display name
 *  from EMAIL_FROM but send from the SMTP mailbox itself. */
function smtpFrom() {
  const display = /^\s*"?([^"<]+?)"?\s*</.exec(config.email.from)?.[1] || 'Aurie'
  return `${display} <${config.email.smtp.user}>`
}

function transports() {
  const resend = { name: 'resend', ready: resendReady(), send: sendViaResend }
  const smtp = { name: 'smtp', ready: smtpReady(), send: sendViaSmtp }
  const ordered = config.email.provider === 'smtp' ? [smtp, resend] : [resend, smtp]
  return ordered.filter((t) => t.ready)
}

export const emailConfigured = () => transports().length > 0

/** Sends `{ to, subject, html, text }`, falling back to the second provider if
 *  the first fails. Throws only if every configured provider failed. */
export async function sendEmail(message) {
  const list = transports()
  if (list.length === 0) {
    console.log(`[mailer:dev] to=${message.to} subject="${message.subject}"\n${message.text || message.html}`)
    return
  }
  const errors = []
  for (const t of list) {
    try {
      await t.send(message)
      if (errors.length) console.warn(`[mailer] delivered via ${t.name} after: ${errors.join(' | ')}`)
      return
    } catch (err) {
      errors.push(`${t.name}: ${err.message}`)
    }
  }
  throw new Error(`Could not send email (${errors.join(' | ')})`)
}

// Echo codes to the console outside production, so local QA does not mean
// digging through an inbox for every OTP.
const logOtpOutsideProd = (channel, to, code) => {
  if (!config.isProd) console.log(`[otp:${channel}] to=${to} code=${code}`)
}

// ----------------------------------------------------------------- layout ---

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const inr = (n) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n || 0)

const longDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' }) : ''

function layout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#F2EFE9;font-family:Helvetica,Arial,sans-serif;color:#2B2622">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" style="max-width:520px;background:#FBFAF7;border:1px solid #E3DED5;border-radius:14px">
<tr><td style="padding:24px 28px 8px;font-size:18px;letter-spacing:3px;font-weight:bold">AURIE</td></tr>
<tr><td style="padding:8px 28px 28px;font-size:15px;line-height:1.55">
<h1 style="font-size:21px;margin:0 0 12px;font-weight:600">${esc(title)}</h1>${bodyHtml}
</td></tr></table>
<p style="font-size:12px;color:#8A8178;margin:14px 0 0">Hand-poured in Mumbai · Reply to this email if anything looks wrong.</p>
</td></tr></table></body></html>`
}

function itemsTable(order) {
  const rows = order.items
    .map(
      (l) => `<tr><td style="padding:6px 0">${esc(l.name)} <span style="color:#8A8178">· ${esc(l.tierLabel)} × ${l.count}</span>${
        l.note ? `<br><span style="color:#8A8178;font-size:13px;font-style:italic">${esc(l.note)}</span>` : ''
      }</td><td align="right" style="padding:6px 0;white-space:nowrap">${inr(l.unitPrice * l.count)}</td></tr>`,
    )
    .join('')
  return `<table role="presentation" width="100%" style="border-top:1px solid #E3DED5;border-bottom:1px solid #E3DED5;margin:16px 0;font-size:14px">${rows}
<tr><td style="padding:6px 0;color:#8A8178">Delivery</td><td align="right">${order.shipping ? inr(order.shipping) : 'Free'}</td></tr>
${order.giftWrapFee ? `<tr><td style="padding:6px 0;color:#8A8178">Gift wrap</td><td align="right">${inr(order.giftWrapFee)}</td></tr>` : ''}
<tr><td style="padding:6px 0;font-weight:bold">Total</td><td align="right" style="font-weight:bold">${inr(order.total)}</td></tr></table>`
}

// ------------------------------------------------------------------ codes ---

export async function sendOtpEmail(email, code) {
  logOtpOutsideProd('email', email, code)
  await sendEmail({
    to: email,
    subject: `${code} is your Aurie sign-in code`,
    text: `Your Aurie sign-in code is ${code}. It expires in 10 minutes. If you did not ask for it, ignore this email.`,
    html: layout(
      'Your sign-in code',
      `<p style="font-size:30px;letter-spacing:6px;font-weight:bold;margin:8px 0 16px">${esc(code)}</p>
<p>It expires in 10 minutes. If you did not ask for this code, you can ignore this email.</p>`,
    ),
  })
}

/** Kept for the phone-verification route, which checkout does not use today. */
export async function sendPhoneOtpFallbackEmail(email, phone, code) {
  logOtpOutsideProd('phone-via-email', email, code)
  await sendEmail({
    to: email,
    subject: `${code} is your Aurie phone verification code`,
    text: `Your code for +91 ${phone} is ${code}. It expires in 10 minutes.`,
    html: layout('Verify your number', `<p>Your code for <strong>+91 ${esc(phone)}</strong> is <strong>${esc(code)}</strong>. It expires in 10 minutes.</p>`),
  })
}

// ----------------------------------------------------------------- orders ---

export async function sendOrderConfirmationEmail(email, order) {
  const a = order.address || {}
  const paid = order.payment?.method === 'upi' ? 'Paid by UPI' : `Cash on delivery — keep ${inr(order.total)} ready`
  await sendEmail({
    to: email,
    subject: `Order ${order.orderNumber} confirmed`,
    text: `We have your order ${order.orderNumber} for ${inr(order.total)}. ${paid}. Expected by ${longDate(order.expectedBy)}.`,
    html: layout(
      `We have your order`,
      `<p>Order <strong>${esc(order.orderNumber)}</strong>. Pouring starts within a day, and you will get a tracking number the day it ships.</p>
${itemsTable(order)}
<p style="margin:0"><strong>Payment:</strong> ${esc(paid)}<br>
<strong>Expected by:</strong> ${esc(longDate(order.expectedBy))} (hand-poured, so this is an estimate)<br>
${order.neededBy ? `<strong>You need it by:</strong> ${esc(longDate(order.neededBy))} — noted<br>` : ''}
${order.gift?.note ? `<strong>Gift note:</strong> “${esc(order.gift.note)}”<br>` : ''}
<strong>Delivering to:</strong> ${esc(a.fullName)}, ${esc(a.line1)}${a.line2 ? `, ${esc(a.line2)}` : ''}, ${esc(a.city)} ${esc(a.pincode)}</p>`,
    ),
  })
}

const STATUS_EMAIL = {
  placed: ['Order received', 'We have your order.'],
  confirmed: ['Pouring has started', 'Your candles are being poured and cured. Wax needs about 48 hours to hold its scent.'],
  shipped: ['Your order has shipped', 'It is on its way.'],
  out_for_delivery: ['Out for delivery', 'It arrives today — keep your phone reachable for the courier.'],
  delivered: ['Delivered', 'Trim the wick to 5mm before the first burn, and let the first burn reach the edge of the jar.'],
  cancelled: ['Order cancelled', 'Your order has been cancelled. If you paid by UPI, the refund goes back to the same account within 5–7 working days.'],
}

export async function sendOrderStatusEmail(email, order) {
  const [title, body] = STATUS_EMAIL[order.status] || ['Order update', `Your order is now ${order.status.replace(/_/g, ' ')}.`]
  const tracking = order.trackingNumber ? `<p><strong>Tracking:</strong> ${esc(order.courier)} · ${esc(order.trackingNumber)}</p>` : ''
  await sendEmail({
    to: email,
    subject: `Order ${order.orderNumber} — ${title.toLowerCase()}`,
    text: `${title}. ${body}${order.trackingNumber ? ` Tracking: ${order.courier} ${order.trackingNumber}` : ''}`,
    html: layout(title, `<p>Order <strong>${esc(order.orderNumber)}</strong>. ${esc(body)}</p>${tracking}`),
  })
}

// ----------------------------------------------------------------- quotes ---

const button = (href, label) =>
  `<p style="margin:22px 0 6px"><a href="${esc(href)}" style="background:#C1441E;color:#FBFAF6;text-decoration:none;padding:12px 22px;border-radius:999px;display:inline-block;font-weight:600">${esc(label)}</a></p>`

const quoteSummary = (q) =>
  `<table role="presentation" width="100%" style="border-top:1px solid #E3DED5;border-bottom:1px solid #E3DED5;margin:16px 0;font-size:14px">
${q.productName ? `<tr><td style="padding:5px 0;color:#8A8178">Starting from</td><td align="right">${esc(q.productName)}</td></tr>` : ''}
${q.occasion ? `<tr><td style="padding:5px 0;color:#8A8178">Occasion</td><td align="right">${esc(q.occasion)}</td></tr>` : ''}
${q.message ? `<tr><td style="padding:5px 0;color:#8A8178">Hidden message</td><td align="right">“${esc(q.message)}”</td></tr>` : ''}
${q.neededBy ? `<tr><td style="padding:5px 0;color:#8A8178">Needed by</td><td align="right">${esc(longDate(q.neededBy))}</td></tr>` : ''}
</table>`

export async function sendQuoteReceivedEmail(email, quote) {
  await sendEmail({
    to: email,
    subject: `We have your request ${quote.number}`,
    text: `Thanks — we have your custom request ${quote.number}. We will reply with a price within a working day.`,
    html: layout(
      'We have your request',
      `<p>Request <strong>${esc(quote.number)}</strong>. A person reads every one — expect a price within a working day.</p>${quoteSummary(quote)}`,
    ),
  })
}

export async function sendQuoteNotifyShopEmail(to, quote, customerEmail, adminUrl) {
  await sendEmail({
    to,
    subject: `New quote request ${quote.number}${quote.productName ? ` — ${quote.productName}` : ''}`,
    text: `${customerEmail} asked for: ${quote.details}`,
    html: layout(
      `New request ${quote.number}`,
      `<p>From <strong>${esc(customerEmail)}</strong>${quote.budget ? ` · budget ${esc(quote.budget)}` : ''}.</p>
${quoteSummary(quote)}<p style="white-space:pre-wrap">${esc(quote.details)}</p>
${quote.images?.length ? `<p>${quote.images.length} reference photo(s) attached in the admin panel.</p>` : ''}
${button(adminUrl, 'Open in admin')}`,
    ),
  })
}

export async function sendQuoteReadyEmail(email, quote, link) {
  await sendEmail({
    to: email,
    subject: `Your quote ${quote.number}: ${inr(quote.price)}`,
    text: `Your custom request ${quote.number} is priced at ${inr(quote.price)} (delivery included). Pay by ${longDate(quote.validUntil)}: ${link}`,
    html: layout(
      'Your quote is ready',
      `<p style="font-size:26px;margin:4px 0 2px;font-weight:bold">${inr(quote.price)}</p>
<p style="margin:0;color:#8A8178">Delivery included · valid until ${esc(longDate(quote.validUntil))}</p>
${quote.adminNote ? `<p style="white-space:pre-wrap">${esc(quote.adminNote)}</p>` : ''}${quoteSummary(quote)}
${button(link, 'Review and pay')}
<p style="font-size:13px;color:#8A8178">Pouring starts once it is paid. Questions? Just reply to this email.</p>`,
    ),
  })
}

export async function sendQuoteDeclinedEmail(email, quote) {
  await sendEmail({
    to: email,
    subject: `About your request ${quote.number}`,
    text: `We cannot take on request ${quote.number}: ${quote.declineReason}`,
    html: layout(
      'We cannot make this one',
      `<p>Thank you for request <strong>${esc(quote.number)}</strong>. Unfortunately we cannot take it on:</p>
<p style="white-space:pre-wrap;border-left:3px solid #E3DED5;padding-left:12px">${esc(quote.declineReason)}</p>
<p>If something close would work, reply to this email and we will suggest options.</p>`,
    ),
  })
}
