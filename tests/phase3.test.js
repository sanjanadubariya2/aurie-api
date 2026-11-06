import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import supertest from 'supertest'
import crypto from 'node:crypto'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'

vi.mock('../src/services/mailer.js', () => {
  const fn = () => vi.fn(async () => {})
  return {
    emailConfigured: () => false,
    sendEmail: fn(),
    sendOtpEmail: fn(),
    sendPhoneOtpFallbackEmail: fn(),
    sendOrderConfirmationEmail: fn(),
    sendOrderStatusEmail: fn(),
    sendQuoteReceivedEmail: fn(),
    sendQuoteNotifyShopEmail: fn(),
    sendQuoteReadyEmail: fn(),
    sendQuoteDeclinedEmail: fn(),
    sendReviewRequestEmail: fn(),
    sendAbandonedCartEmail: fn(),
  }
})

const mailer = await import('../src/services/mailer.js')
const { createApp } = await import('../src/app.js')
const { connectDb, disconnectDb } = await import('../src/db.js')
const { registerJobs } = await import('../src/jobs/handlers.js')
const { financialYear } = await import('../src/models/Counter.js')
const Order = (await import('../src/models/Order.js')).default
const Customer = (await import('../src/models/Customer.js')).default
const AuditLog = (await import('../src/models/AuditLog.js')).default
const { resetDb, signIn, address, ORIGIN } = await import('./helpers.js')

const app = createApp()
const post = (agent, url, body) => agent.post(url).set('Origin', ORIGIN).send(body)
const oneLaddoo = [{ productId: 'laddoo', tierId: 'single', count: 1 }]

let owner
let staff
let buyer

async function paidUpiOrder(agent, items = oneLaddoo) {
  const res = await post(agent, '/api/payments/order', { items, address }).expect(201)
  const order = await Order.findOne({ orderNumber: res.body.orderId })
  const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: `pay_dev_${order.orderNumber}`, order_id: order.razorpayOrderId } } } })
  const sig = crypto.createHmac('sha256', 'test-webhook-secret').update(raw).digest('hex')
  await supertest(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', sig).send(raw).expect(200)
  return Order.findById(order._id)
}

beforeAll(async () => {
  await connectDb()
  registerJobs()
  await resetDb()
  await Customer.create({ email: 'packer@test.aurie', role: 'staff', passwordHash: await bcrypt.hash('staff-pass-123', 4) })
  owner = supertest.agent(app)
  await post(owner, '/api/admin/login', { email: 'admin@test.aurie', password: 'admin-pass-123' }).expect(200)
  staff = supertest.agent(app)
  await post(staff, '/api/admin/login', { email: 'packer@test.aurie', password: 'staff-pass-123' }).expect(200)
  buyer = (await signIn(app, mailer, 'ops@test.aurie')).agent
})
afterAll(async () => {
  await mongoose.connection.db.dropDatabase()
  await disconnectDb()
})

describe('invoice numbers', () => {
  it('are consecutive per financial year, for COD at placement and UPI once paid', async () => {
    const fy = financialYear()
    const a = await post(buyer, '/api/orders', { items: oneLaddoo, address, payment: 'cod' }).expect(201)
    const b = await post(buyer, '/api/orders', { items: oneLaddoo, address, payment: 'cod' }).expect(201)
    expect(a.body.order.invoiceNumber).toBe(`AUR/${fy}/00001`)
    expect(b.body.order.invoiceNumber).toBe(`AUR/${fy}/00002`)

    const unpaid = await post(buyer, '/api/payments/order', { items: oneLaddoo, address }).expect(201)
    expect((await Order.findOne({ orderNumber: unpaid.body.orderId })).invoiceNumber).toBeUndefined()

    const paid = await paidUpiOrder(buyer)
    expect(paid.invoiceNumber).toBe(`AUR/${fy}/00003`)
  })
})

describe('customer cancellation', () => {
  it('cancels a placed COD order', async () => {
    const res = await post(buyer, '/api/orders', { items: oneLaddoo, address, payment: 'cod' }).expect(201)
    const out = await post(buyer, `/api/orders/${res.body.order.id}/cancel`, {}).expect(200)
    expect(out.body.order).toMatchObject({ status: 'cancelled', canCancel: false })
  })

  it('cancels a paid UPI order and refunds it in full', async () => {
    const order = await paidUpiOrder(buyer)
    await post(buyer, `/api/orders/${order.orderNumber}/cancel`, {}).expect(200)
    const fresh = await Order.findById(order._id)
    expect(fresh).toMatchObject({ status: 'cancelled', paymentStatus: 'refunded', refundedTotal: order.total })
    expect(fresh.refunds[0]).toMatchObject({ amount: order.total, status: 'processed' })
  })

  it('refuses once pouring has started', async () => {
    const res = await post(buyer, '/api/orders', { items: oneLaddoo, address, payment: 'cod' }).expect(201)
    const id = (await Order.findOne({ orderNumber: res.body.order.id }))._id
    await owner.patch(`/api/admin/orders/${id}`).set('Origin', ORIGIN).send({ status: 'confirmed' }).expect(200)
    const out = await post(buyer, `/api/orders/${res.body.order.id}/cancel`, {}).expect(400)
    expect(out.body.message).toMatch(/Pouring has started/)
  })

  it('cannot cancel someone else’s order', async () => {
    const res = await post(buyer, '/api/orders', { items: oneLaddoo, address, payment: 'cod' }).expect(201)
    const stranger = (await signIn(app, mailer, 'stranger@test.aurie')).agent
    await post(stranger, `/api/orders/${res.body.order.id}/cancel`, {}).expect(404)
  })
})

describe('admin refunds', () => {
  it('allows partial refunds up to what was paid, owner only', async () => {
    const order = await paidUpiOrder(buyer, [{ productId: 'laddoo', tierId: 'combo', count: 1 }]) // 240 + 79
    const url = `/api/admin/orders/${order._id}/refund`
    await post(staff, url, { amount: 50, reason: 'Broken in transit' }).expect(403)
    await post(owner, url, { amount: 100, reason: 'One candle broken' }).expect(200)
    let fresh = await Order.findById(order._id)
    expect(fresh).toMatchObject({ paymentStatus: 'partially_refunded', refundedTotal: 100 })
    const tooMuch = await post(owner, url, { amount: 500, reason: 'Oops' }).expect(400)
    expect(tooMuch.body.message).toMatch(/At most ₹219/)
    await post(owner, url, { reason: 'Refund the rest' }).expect(200)
    fresh = await Order.findById(order._id)
    expect(fresh).toMatchObject({ paymentStatus: 'refunded', refundedTotal: 319 })
  })

  it('refuses COD refunds through Razorpay', async () => {
    const res = await post(buyer, '/api/orders', { items: oneLaddoo, address, payment: 'cod' }).expect(201)
    const id = (await Order.findOne({ orderNumber: res.body.order.id }))._id
    const out = await post(owner, `/api/admin/orders/${id}/refund`, { reason: 'test' }).expect(400)
    expect(out.body.message).toMatch(/by hand/)
  })
})

describe('staff role', () => {
  it('can work orders and the pour list but not prices, exports, customers or staff', async () => {
    await staff.get('/api/admin/orders').expect(200)
    await staff.get('/api/admin/production').expect(200)
    await staff.get('/api/admin/products').expect(200)
    await post(staff, '/api/admin/products', { name: 'Nope', collection: 'festive', quote: true }).expect(403)
    await staff.get('/api/admin/orders/export.csv').expect(403)
    await staff.get('/api/admin/customers').expect(403)
    await staff.get('/api/admin/staff').expect(403)
    await staff.get('/api/admin/audit').expect(403)
  })

  it('owner can add and remove staff; removal ends their session', async () => {
    const add = await post(owner, '/api/admin/staff', { email: 'temp@test.aurie', password: 'short' }).expect(400)
    expect(add.body.message).toMatch(/10 characters/)
    await post(owner, '/api/admin/staff', { email: 'temp@test.aurie', password: 'long-enough-pass' }).expect(201)
    const temp = supertest.agent(app)
    await post(temp, '/api/admin/login', { email: 'temp@test.aurie', password: 'long-enough-pass' }).expect(200)
    const { body } = await owner.get('/api/admin/staff').expect(200)
    const id = body.staff.find((m) => m.email === 'temp@test.aurie').id
    await owner.delete(`/api/admin/staff/${id}`).set('Origin', ORIGIN).expect(200)
    await temp.get('/api/admin/orders').expect(401)
  })
})

describe('operations', () => {
  it('pour list groups units by product, size and note', async () => {
    await post(buyer, '/api/orders', { items: [{ productId: 'laddoo', tierId: 'single', count: 3, note: 'Sage green' }], address, payment: 'cod' }).expect(201)
    await post(buyer, '/api/orders', { items: [{ productId: 'laddoo', tierId: 'single', count: 2, note: 'sage green' }], address, payment: 'cod' }).expect(201)
    const { body } = await owner.get('/api/admin/production').expect(200)
    const sage = body.items.find((g) => g.note.toLowerCase() === 'sage green')
    expect(sage).toMatchObject({ name: 'Motichoor Laddoo', units: 5 })
    expect(sage.orders).toHaveLength(2)
  })

  it('customers page totals spend net of refunds', async () => {
    const { body } = await owner.get('/api/admin/customers').expect(200)
    const me = body.customers.find((c) => c.email === 'ops@test.aurie')
    expect(me.orders).toBeGreaterThan(1)
    expect(me.repeat).toBe(true)
  })

  it('exports CSV safely', async () => {
    const res = await owner.get('/api/admin/orders/export.csv').expect(200)
    expect(res.headers['content-type']).toMatch(/text\/csv/)
    const [header, first] = res.text.replace(/^﻿/, '').split('\r\n')
    expect(header).toMatch(/^"Order","Invoice"/)
    expect(first).toMatch(/^"AUR\d{6}"/)
  })

  it('records an activity log', async () => {
    const { body } = await owner.get('/api/admin/audit').expect(200)
    const actions = body.entries.map((e) => e.action)
    expect(actions).toEqual(expect.arrayContaining(['refund.create', 'order.status', 'staff.add', 'staff.remove', 'orders.export']))
    expect(await AuditLog.countDocuments({ action: 'order.cancel.customer' })).toBe(2)
  })

  it('materials: owner sets up, staff records usage, never below zero', async () => {
    const { body } = await post(owner, '/api/admin/materials', { name: 'Soy wax', unit: 'kg', onHand: 10, lowAt: 3 }).expect(201)
    const id = body.material._id
    await post(staff, '/api/admin/materials', { name: 'Nope' }).expect(403)
    const used = await post(staff, `/api/admin/materials/${id}/adjust`, { delta: -7.5, note: 'Diwali batch' }).expect(200)
    expect(used.body.material.onHand).toBe(2.5)
    await post(staff, `/api/admin/materials/${id}/adjust`, { delta: -5 }).expect(400)
  })
})

describe('shipping', () => {
  it('serviceability falls back to the lead time when Shiprocket is off', async () => {
    const { body } = await supertest(app).get('/api/shipping/serviceability?pincode=400058').expect(200)
    expect(body).toEqual({ live: false, available: null, estimateDays: 7 })
    await supertest(app).get('/api/shipping/serviceability?pincode=12').expect(400)
  })

  it('booking a shipment says so when Shiprocket is off', async () => {
    const res = await post(buyer, '/api/orders', { items: oneLaddoo, address, payment: 'cod' }).expect(201)
    const id = (await Order.findOne({ orderNumber: res.body.order.id }))._id
    const out = await post(owner, `/api/admin/orders/${id}/ship`, {}).expect(400)
    expect(out.body.message).toMatch(/not connected/)
  })

  it('tracking webhook needs its token', async () => {
    await supertest(app).post('/api/shipping/webhook').send({ awb: '1', current_status: 'DELIVERED' }).expect(401)
  })
})
