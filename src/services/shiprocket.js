import { HttpError } from '../lib/HttpError.js'
import { logger } from '../lib/logger.js'

/**
 * Shiprocket (one API over Delhivery, Bluedart, Xpressbees…). Switched off
 * until SHIPROCKET_EMAIL + SHIPROCKET_PASSWORD are set — create an "API user"
 * in Shiprocket (Settings > API > Configure), not your main login.
 *
 * Used for: pincode serviceability + delivery estimate on product pages, and
 * one-click "book shipment" from the admin order drawer (creates the order,
 * assigns an AWB, requests pickup, fetches the label).
 */

const BASE = 'https://apiv2.shiprocket.in/v1/external'
const log = logger.child({ module: 'shiprocket' })

const cfg = () => ({
  email: process.env.SHIPROCKET_EMAIL || '',
  password: process.env.SHIPROCKET_PASSWORD || '',
  pickupPincode: process.env.SHIPROCKET_PICKUP_PINCODE || '400001',
  pickupLocation: process.env.SHIPROCKET_PICKUP_LOCATION || 'Primary',
  webhookToken: process.env.SHIPROCKET_WEBHOOK_TOKEN || '',
  // Packed weight per order line in kg, and box size in cm — tune to your packaging.
  weightPerItemKg: Number(process.env.SHIPROCKET_WEIGHT_PER_ITEM_KG || 0.35),
})

export const isShiprocketLive = () => Boolean(cfg().email && cfg().password)

let token = null
let tokenExpires = 0
async function auth() {
  if (token && Date.now() < tokenExpires) return token
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: cfg().email, password: cfg().password }),
    signal: AbortSignal.timeout(15_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.token) {
    log.error({ status: res.status, message: data.message }, 'shiprocket login failed')
    throw new HttpError(502, 'Could not sign in to Shiprocket. Check SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD.')
  }
  token = data.token
  tokenExpires = Date.now() + 9 * 86_400_000 // tokens last 10 days
  return token
}

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await auth()}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    log.error({ path, status: res.status, message: data.message }, 'shiprocket error')
    throw new HttpError(502, `Shiprocket: ${data.message || `request failed (${res.status})`}`)
  }
  return data
}

/** Can a courier reach this pincode, and roughly when? */
export async function checkServiceability({ pincode, cod = false, weightKg = 0.5 }) {
  const q = new URLSearchParams({
    pickup_postcode: cfg().pickupPincode,
    delivery_postcode: pincode,
    weight: String(weightKg),
    cod: cod ? '1' : '0',
  })
  const data = await call('GET', `/courier/serviceability/?${q}`)
  const couriers = data?.data?.available_courier_companies || []
  if (!couriers.length) return { available: false }
  const fastest = couriers.reduce((a, b) => (Number(a.estimated_delivery_days) <= Number(b.estimated_delivery_days) ? a : b))
  return {
    available: true,
    codAvailable: couriers.some((c) => Number(c.cod) === 1),
    transitDays: Number(fastest.estimated_delivery_days) || null,
    city: fastest.city || null,
  }
}

/** Books the shipment for an Aurie order end to end. Returns courier + AWB + label. */
export async function bookShipment(order) {
  const a = order.address
  const units = order.items.reduce((n, l) => n + l.count, 0)
  const created = await call('POST', '/orders/create/adhoc', {
    order_id: order.orderNumber,
    order_date: new Date(order.createdAt).toISOString().slice(0, 16).replace('T', ' '),
    pickup_location: cfg().pickupLocation,
    billing_customer_name: a.fullName,
    billing_last_name: '',
    billing_address: a.line1,
    billing_address_2: a.line2 || '',
    billing_city: a.city,
    billing_pincode: a.pincode,
    billing_state: a.state,
    billing_country: 'India',
    billing_email: order.customer?.email || '',
    billing_phone: a.phone,
    shipping_is_billing: true,
    order_items: order.items.map((l) => ({
      name: l.name,
      sku: `${l.productId}-${l.tierId}`.slice(0, 50),
      units: l.count,
      selling_price: l.unitPrice,
    })),
    payment_method: order.payment.method === 'cod' ? 'COD' : 'Prepaid',
    shipping_charges: order.shipping || 0,
    sub_total: order.total,
    length: 20,
    breadth: 15,
    height: 12,
    weight: Math.max(0.5, +(units * cfg().weightPerItemKg).toFixed(2)),
  })

  const shipmentId = created.shipment_id
  const awb = await call('POST', '/courier/assign/awb', { shipment_id: shipmentId })
  const awbData = awb?.response?.data || {}
  await call('POST', '/courier/generate/pickup', { shipment_id: [shipmentId] }).catch((err) =>
    log.warn({ err: err.message, order: order.orderNumber }, 'pickup request failed — request it in Shiprocket'),
  )
  const label = await call('POST', '/courier/generate/label', { shipment_id: [shipmentId] }).catch(() => ({}))

  return {
    shiprocketOrderId: String(created.order_id),
    shipmentId: String(shipmentId),
    awb: awbData.awb_code,
    courier: awbData.courier_name,
    labelUrl: label.label_url || '',
  }
}

/** Shiprocket's tracking webhook sends this token in the x-api-key header. */
export const webhookTokenOk = (headerValue) => Boolean(cfg().webhookToken) && headerValue === cfg().webhookToken

/** Maps Shiprocket's shipment status text onto our order statuses. */
export function mapShipmentStatus(text = '') {
  const s = String(text).toUpperCase()
  if (s.includes('DELIVERED') && !s.includes('UNDELIVERED') && !s.includes('RTO')) return 'delivered'
  if (s.includes('OUT FOR DELIVERY')) return 'out_for_delivery'
  if (s.includes('PICKED UP') || s.includes('IN TRANSIT') || s.includes('SHIPPED')) return 'shipped'
  return null
}
