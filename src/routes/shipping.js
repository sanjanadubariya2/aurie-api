import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import Order from '../models/Order.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { SHOP } from '../lib/settings.js'
import { audit } from '../lib/audit.js'
import { notifyStatusChange } from '../lib/orderEvents.js'
import { isShiprocketLive, checkServiceability, webhookTokenOk, mapShipmentStatus } from '../services/shiprocket.js'
import { logger } from '../lib/logger.js'

/**
 *   GET  /shipping/serviceability?pincode=400058 -> { live, available, codAvailable, transitDays, estimateDays }
 *   POST /shipping/webhook   Shiprocket tracking updates (x-api-key: SHIPROCKET_WEBHOOK_TOKEN)
 */
const router = Router()

router.get(
  '/serviceability',
  rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false }),
  asyncHandler(async (req, res) => {
    const pincode = String(req.query.pincode || '').trim()
    if (!/^[1-9]\d{5}$/.test(pincode)) return res.status(400).json({ message: 'Enter a valid 6-digit PIN code' })
    // Without Shiprocket we cannot check couriers — but we can still give the honest lead time.
    if (!isShiprocketLive()) return res.json({ live: false, available: null, estimateDays: SHOP.leadTimeDays })
    const result = await checkServiceability({ pincode }).catch((err) => {
      logger.warn({ err: err.message }, 'serviceability lookup failed')
      return { available: null }
    })
    const curingDays = SHOP.leadTimeDays - 3 // pour + cure; the rest is transit
    res.set('Cache-Control', 'public, max-age=3600')
    res.json({
      live: true,
      ...result,
      estimateDays: result.transitDays ? curingDays + result.transitDays : SHOP.leadTimeDays,
    })
  }),
)

router.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    if (!webhookTokenOk(req.headers['x-api-key'])) return res.status(401).json({ message: 'Bad token' })
    const { awb, current_status: currentStatus } = req.body || {}
    const next = mapShipmentStatus(currentStatus)
    if (awb && next) {
      const order = await Order.findOne({ 'shiprocket.awb': String(awb) }).populate('customer', 'email')
      const flow = ['placed', 'confirmed', 'shipped', 'out_for_delivery', 'delivered']
      // Only ever move forward — couriers resend old events.
      if (order && flow.indexOf(next) > flow.indexOf(order.status)) {
        order.status = next
        order.statusHistory.push({ status: next, at: new Date(), by: 'shiprocket' })
        await order.save()
        await notifyStatusChange(order)
        await audit('shiprocket', 'order.status', order.orderNumber, { status: next, awb })
      }
    }
    res.json({ ok: true }) // always 200 so Shiprocket does not retry forever
  }),
)

export default router
