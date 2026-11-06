import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import Order from '../models/Order.js'
import Customer from '../models/Customer.js'
import AuditLog from '../models/AuditLog.js'
import Material from '../models/Material.js'
import { requireOwner } from '../middleware/requireAdmin.js'
import { validateBody } from '../middleware/validate.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { HttpError } from '../lib/HttpError.js'
import { auditReq } from '../lib/audit.js'
import { refundOrder } from '../lib/refunds.js'
import { notifyStatusChange } from '../lib/orderEvents.js'
import { publicCustomer } from '../lib/serialize.js'
import { isShiprocketLive, bookShipment } from '../services/shiprocket.js'

/**
 * Operations for the admin panel. Mounted inside routes/admin.js after the
 * session + team checks, so everything here already has req.customer.
 * Owner-only routes add requireOwner.
 */
const router = Router()
const LIVE_STATUSES = ['placed', 'confirmed']
const SOLD = { status: { $nin: ['cancelled', 'awaiting_payment'] }, $or: [{ paymentStatus: { $in: ['paid', 'partially_refunded'] } }, { 'payment.method': 'cod' }] }

// --------------------------------------------------------------- refunds ---
router.post(
  '/orders/:id/refund',
  requireOwner,
  validateBody(z.object({ amount: z.number().int().min(1).optional(), reason: z.string().trim().min(3, 'Give a reason').max(300) })),
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id).catch(() => null)
    if (!order) throw new HttpError(404, 'Order not found')
    const updated = await refundOrder({ order, amount: req.body.amount, reason: req.body.reason, by: req.customer.email })
    res.json({ order: updated })
  }),
)

// -------------------------------------------------------------- shipping ---
router.post(
  '/orders/:id/ship',
  asyncHandler(async (req, res) => {
    if (!isShiprocketLive()) throw new HttpError(400, 'Shiprocket is not connected. Add the courier and tracking number by hand.')
    const order = await Order.findById(req.params.id).populate('customer', 'email')
    if (!order) throw new HttpError(404, 'Order not found')
    if (order.status !== 'confirmed') throw new HttpError(400, 'Book shipping once the order is poured (status "Pouring started").')
    if (order.shiprocket?.awb) throw new HttpError(400, 'A shipment is already booked for this order.')

    const s = await bookShipment(order)
    order.shiprocket = { orderId: s.shiprocketOrderId, shipmentId: s.shipmentId, awb: s.awb, labelUrl: s.labelUrl }
    order.courier = s.courier
    order.trackingNumber = s.awb
    order.status = 'shipped'
    order.statusHistory.push({ status: 'shipped', at: new Date(), by: `${req.customer.email} via Shiprocket` })
    await order.save()
    await notifyStatusChange(order)
    await auditReq(req, 'order.ship', order.orderNumber, { awb: s.awb, courier: s.courier })
    res.json({ order })
  }),
)

// ------------------------------------------------------------ pour list ---
/**
 * What to make: every unit on orders that are placed or pouring, grouped by
 * product, size and the customer's colour/scent note. Orders with a needed-by
 * date sort first, then oldest first.
 */
router.get(
  '/production',
  asyncHandler(async (req, res) => {
    const orders = await Order.find({ status: { $in: LIVE_STATUSES } })
      .populate('customer', 'email')
      .sort({ createdAt: 1 })
      .limit(500)

    const groups = new Map()
    for (const o of orders) {
      for (const l of o.items) {
        const key = `${l.productId}::${l.tierId}::${(l.note || '').trim().toLowerCase()}`
        const g = groups.get(key) || { key, productId: l.productId, name: l.name, image: l.image, tierLabel: l.tierLabel, note: l.note || '', units: 0, orders: [], neededBy: null }
        g.units += l.count
        g.orders.push({ id: o._id, orderNumber: o.orderNumber, count: l.count, status: o.status })
        if (o.neededBy && (!g.neededBy || o.neededBy < g.neededBy)) g.neededBy = o.neededBy
        groups.set(key, g)
      }
    }
    const items = [...groups.values()].sort((a, b) => {
      if (a.neededBy && b.neededBy) return a.neededBy - b.neededBy
      if (a.neededBy) return -1
      if (b.neededBy) return 1
      return b.units - a.units
    })

    const queue = orders
      .map((o) => ({
        id: o._id,
        orderNumber: o.orderNumber,
        status: o.status,
        createdAt: o.createdAt,
        neededBy: o.neededBy || null,
        expectedBy: o.expectedBy,
        units: o.items.reduce((n, l) => n + l.count, 0),
        gift: Boolean(o.gift?.wrap || o.gift?.note),
        customer: o.customer?.email,
        city: o.address?.city,
      }))
      .sort((a, b) => (a.neededBy || a.expectedBy) - (b.neededBy || b.expectedBy))

    res.json({ items, queue, totals: { orders: orders.length, units: items.reduce((n, g) => n + g.units, 0) } })
  }),
)

// ------------------------------------------------------------- customers ---
router.get(
  '/customers',
  requireOwner,
  asyncHandler(async (req, res) => {
    const rows = await Order.aggregate([
      { $match: SOLD },
      {
        $group: {
          _id: '$customer',
          orders: { $sum: 1 },
          spend: { $sum: { $subtract: ['$total', { $ifNull: ['$refundedTotal', 0] }] } },
          firstOrder: { $min: '$createdAt' },
          lastOrder: { $max: '$createdAt' },
          city: { $last: '$address.city' },
          name: { $last: '$address.fullName' },
          phone: { $last: '$address.phone' },
        },
      },
      { $lookup: { from: 'customers', localField: '_id', foreignField: '_id', as: 'c' } },
      { $unwind: '$c' },
      { $sort: { spend: -1 } },
      { $limit: 1000 },
    ])
    res.json({
      customers: rows.map((r) => ({
        id: r._id,
        email: r.c.email,
        name: r.name || r.c.name || '',
        phone: r.phone || '',
        city: r.city || '',
        orders: r.orders,
        spend: r.spend,
        firstOrder: r.firstOrder,
        lastOrder: r.lastOrder,
        repeat: r.orders > 1,
      })),
    })
  }),
)

// ---------------------------------------------------------------- export ---
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v)
  // Quote everything; neutralise spreadsheet formula injection (=, +, -, @).
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`
}

router.get(
  '/orders/export.csv',
  requireOwner,
  asyncHandler(async (req, res) => {
    const from = req.query.from ? new Date(`${req.query.from}T00:00:00+05:30`) : new Date(Date.now() - 31 * 86_400_000)
    const to = req.query.to ? new Date(`${req.query.to}T23:59:59+05:30`) : new Date()
    const orders = await Order.find({ createdAt: { $gte: from, $lte: to }, status: { $ne: 'awaiting_payment' } })
      .populate('customer', 'email')
      .sort({ createdAt: 1 })

    const header = ['Order', 'Invoice', 'Date (IST)', 'Status', 'Payment', 'Payment status', 'Customer email', 'Name', 'Phone', 'City', 'State', 'PIN', 'Items', 'Subtotal', 'Delivery', 'Gift wrap', 'Total', 'Refunded', 'Courier', 'Tracking']
    const lines = orders.map((o) =>
      [
        o.orderNumber,
        o.invoiceNumber,
        o.createdAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        o.status,
        o.payment?.method,
        o.paymentStatus,
        o.customer?.email,
        o.address?.fullName,
        o.address?.phone,
        o.address?.city,
        o.address?.state,
        o.address?.pincode,
        o.items.map((l) => `${l.name} (${l.tierLabel}) x${l.count}`).join('; '),
        o.subtotal,
        o.shipping,
        o.giftWrapFee || 0,
        o.total,
        o.refundedTotal || 0,
        o.courier,
        o.trackingNumber,
      ]
        .map(csvCell)
        .join(','),
    )
    await auditReq(req, 'orders.export', null, { from, to, count: orders.length })
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="aurie-orders-${req.query.from || 'last-31-days'}.csv"`)
    res.send(`\uFEFF${[header.map(csvCell).join(','), ...lines].join('\r\n')}`) // BOM so Excel reads ₹ correctly
  }),
)

// ------------------------------------------------------------- activity ---
router.get(
  '/audit',
  requireOwner,
  asyncHandler(async (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 200)
    const filter = req.query.target ? { target: String(req.query.target) } : {}
    const entries = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(limit)
    res.json({ entries })
  }),
)

// ------------------------------------------------------------ materials ---
const materialSchema = z.object({
  name: z.string().trim().min(1, 'Name it').max(80),
  unit: z.string().trim().max(12).optional().default('pcs'),
  onHand: z.number().min(0).optional().default(0),
  lowAt: z.number().min(0).optional().default(0),
  supplier: z.string().trim().max(120).optional().default(''),
  notes: z.string().trim().max(500).optional().default(''),
})

router.get(
  '/materials',
  asyncHandler(async (req, res) => {
    const materials = await Material.find().sort({ name: 1 })
    res.json({ materials })
  }),
)
router.post(
  '/materials',
  requireOwner,
  validateBody(materialSchema),
  asyncHandler(async (req, res) => {
    const material = await Material.create(req.body)
    await auditReq(req, 'material.create', material.name)
    res.status(201).json({ material })
  }),
)
router.patch(
  '/materials/:id',
  requireOwner,
  validateBody(materialSchema.partial()),
  asyncHandler(async (req, res) => {
    const material = await Material.findByIdAndUpdate(req.params.id, req.body, { new: true }).catch(() => null)
    if (!material) throw new HttpError(404, 'Material not found')
    await auditReq(req, 'material.update', material.name, req.body)
    res.json({ material })
  }),
)
/** Stock in (+) or used (−). Staff can record usage; the change is logged. */
router.post(
  '/materials/:id/adjust',
  validateBody(z.object({ delta: z.number().refine((n) => n !== 0, 'Enter an amount'), note: z.string().trim().max(200).optional().default('') })),
  asyncHandler(async (req, res) => {
    const material = await Material.findById(req.params.id).catch(() => null)
    if (!material) throw new HttpError(404, 'Material not found')
    if (material.onHand + req.body.delta < 0) throw new HttpError(400, `Only ${material.onHand} ${material.unit} on hand.`)
    material.onHand = +(material.onHand + req.body.delta).toFixed(3)
    await material.save()
    await auditReq(req, 'material.adjust', material.name, { delta: req.body.delta, note: req.body.note, onHand: material.onHand })
    res.json({ material })
  }),
)
router.delete(
  '/materials/:id',
  requireOwner,
  asyncHandler(async (req, res) => {
    const material = await Material.findByIdAndDelete(req.params.id).catch(() => null)
    if (!material) throw new HttpError(404, 'Material not found')
    await auditReq(req, 'material.delete', material.name)
    res.json({ ok: true })
  }),
)

// ----------------------------------------------------------------- staff ---
router.get(
  '/staff',
  requireOwner,
  asyncHandler(async (req, res) => {
    const team = await Customer.find({ role: { $in: ['admin', 'staff'] } }).sort({ role: 1, email: 1 })
    res.json({ staff: team.map((m) => ({ ...publicCustomer(m), totpEnabled: Boolean(m.totpEnabled), self: m._id.equals(req.customer._id) })) })
  }),
)

router.post(
  '/staff',
  requireOwner,
  validateBody(
    z.object({
      email: z.string().trim().toLowerCase().email(),
      password: z.string().min(10, 'Use at least 10 characters'),
      role: z.enum(['staff', 'admin']).optional().default('staff'),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { email, password, role } = req.body
    const member = await Customer.findOneAndUpdate(
      { email },
      { $set: { role, passwordHash: await bcrypt.hash(password, 10) }, $inc: { tokenVersion: 1 } },
      { upsert: true, new: true },
    )
    await auditReq(req, 'staff.add', email, { role })
    res.status(201).json({ member: publicCustomer(member) })
  }),
)

router.delete(
  '/staff/:id',
  requireOwner,
  asyncHandler(async (req, res) => {
    if (req.customer._id.equals(req.params.id)) throw new HttpError(400, 'You cannot remove yourself.')
    const member = await Customer.findOneAndUpdate(
      { _id: req.params.id, role: { $in: ['admin', 'staff'] } },
      { $set: { role: 'customer' }, $unset: { passwordHash: 1, totpSecretEnc: 1 }, $inc: { tokenVersion: 1 } },
      { new: true },
    ).catch(() => null)
    if (!member) throw new HttpError(404, 'Team member not found')
    await auditReq(req, 'staff.remove', member.email)
    res.json({ ok: true })
  }),
)

export default router
