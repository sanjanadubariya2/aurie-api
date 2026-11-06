import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import crypto from 'node:crypto'
import mongoose from 'mongoose'
import { authenticator } from 'otplib'

// Tests never send real email — every mailer function is a spy.
vi.mock('../src/services/mailer.js', () => ({
  emailConfigured: () => false,
  sendEmail: vi.fn(async () => {}),
  sendOtpEmail: vi.fn(async () => {}),
  sendPhoneOtpFallbackEmail: vi.fn(async () => {}),
  sendOrderConfirmationEmail: vi.fn(async () => {}),
  sendOrderStatusEmail: vi.fn(async () => {}),
  sendQuoteReceivedEmail: vi.fn(async () => {}),
  sendQuoteNotifyShopEmail: vi.fn(async () => {}),
  sendQuoteReadyEmail: vi.fn(async () => {}),
  sendQuoteDeclinedEmail: vi.fn(async () => {}),
  sendReviewRequestEmail: vi.fn(async () => {}),
  sendAbandonedCartEmail: vi.fn(async () => {}),
}))

const mailer = await import('../src/services/mailer.js')
const { createApp } = await import('../src/app.js')
const { connectDb, disconnectDb } = await import('../src/db.js')
const { registerJobs } = await import('../src/jobs/handlers.js')
const { runDue, enqueue } = await import('../src/jobs/queue.js')
const { createOrderFromCart } = await import('../src/lib/createOrder.js')
const Order = (await import('../src/models/Order.js')).default
const Customer = (await import('../src/models/Customer.js')).default
const { resetDb, signIn, address, ORIGIN } = await import('./helpers.js')

const app = createApp()
const api = supertest(app)
const post = (agent, url, body) => agent.post(url).set('Origin', ORIGIN).send(body)
const oneLaddoo = [{ productId: 'laddoo', tierId: 'single', count: 1 }]

beforeAll(async () => {
  await connectDb()
  registerJobs()
  await resetDb()
})
afterAll(async () => {
  await mongoose.connection.db.dropDatabase()
  await disconnectDb()
})
beforeEach(() => vi.clearAllMocks())

describe('catalogue and settings', () => {
  it('serves settings with the business rules', async () => {
    const { body } = await api.get('/api/settings').expect(200)
    expect(body.settings).toMatchObject({ freeShippingFrom: 999, shippingFee: 79, codLimit: 2000, maxPerLine: 20 })
    expect(body.settings.statusFlow).toEqual(['placed', 'confirmed', 'shipped', 'out_for_delivery', 'delivered'])
  })

  it('lists only active products in the storefront shape', async () => {
    const { body } = await api.get('/api/products').expect(200)
    expect(body.products.map((p) => p.id).sort()).toEqual(['laddoo', 'love-note', 'tulip-jar'])
    expect(body.products.find((p) => p.id === 'love-note').quote).toBe(true)
  })

  it('reports db health', async () => {
    await api.get('/health').expect(200, { ok: true, db: true })
  })
})

describe('customer sessions', () => {
  it('signs in with an email code and sets an httpOnly session cookie', async () => {
    const { res, agent } = await signIn(app, mailer)
    const cookie = res.headers['set-cookie'].join(';')
    expect(cookie).toMatch(/aurie_session=/)
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    const me = await agent.get('/api/auth/me').expect(200)
    expect(me.body.customer.email).toBe('buyer@test.aurie')
  })

  it('rejects a wrong code and makes codes single-use', async () => {
    await post(api, '/api/auth/email/otp', { email: 'once@test.aurie' }).expect(200)
    const code = vi.mocked(mailer.sendOtpEmail).mock.calls.at(-1)[1]
    const wrong = code === '000000' ? '111111' : '000000'
    await post(api, '/api/auth/email/verify', { email: 'once@test.aurie', code: wrong }).expect(400)
    await post(api, '/api/auth/email/verify', { email: 'once@test.aurie', code }).expect(200)
    await post(api, '/api/auth/email/verify', { email: 'once@test.aurie', code }).expect(400)
  })

  it('logout clears the cookie', async () => {
    const { agent } = await signIn(app, mailer, 'logout@test.aurie')
    const res = await post(agent, '/api/auth/logout', {}).expect(200)
    expect(res.headers['set-cookie'].join(';')).toMatch(/aurie_session=;/)
    await agent.get('/api/auth/me').expect(401)
  })

  it('logout-all kills every issued token', async () => {
    const { agent, token } = await signIn(app, mailer, 'multi@test.aurie')
    await post(agent, '/api/auth/logout-all', {}).expect(200)
    await api.get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(401)
  })

  it('blocks state-changing requests from unknown origins', async () => {
    await api.post('/api/auth/email/otp').set('Origin', 'https://evil.example').send({ email: 'x@test.aurie' }).expect(403)
  })

  it('limits code requests per email', async () => {
    for (let i = 0; i < 5; i++) await post(api, '/api/auth/email/otp', { email: 'spam@test.aurie' }).expect(200)
    await post(api, '/api/auth/email/otp', { email: 'spam@test.aurie' }).expect(429)
  })
})

describe('orders', () => {
  let buyer
  beforeAll(async () => {
    buyer = await signIn(app, mailer, 'orders@test.aurie')
  })

  it('prices a COD order on the server and ignores the client total', async () => {
    const res = await post(buyer.agent, '/api/orders', {
      items: [{ productId: 'laddoo', tierId: 'combo', count: 2 }],
      address,
      payment: 'cod',
      total: 1,
    }).expect(201)
    expect(res.body.order).toMatchObject({ total: 480 + 79, status: 'placed', payment: 'cod', paymentStatus: 'pending' })
  })

  it('sends exactly one confirmation email via the job queue', async () => {
    const res = await post(buyer.agent, '/api/orders', { items: oneLaddoo, address, payment: 'cod' }).expect(201)
    await runDue()
    await runDue()
    const order = await Order.findOne({ orderNumber: res.body.order.id })
    expect(order.confirmationSentAt).toBeTruthy()
    const sent = vi.mocked(mailer.sendOrderConfirmationEmail).mock.calls.filter(([, o]) => o.orderNumber === order.orderNumber)
    expect(sent).toHaveLength(1)
  })

  it.each([
    ['UPI outside Razorpay', { items: oneLaddoo, payment: 'upi' }],
    ['a quote-only product', { items: [{ productId: 'love-note', tierId: 'single', count: 1 }], payment: 'cod' }],
    ['a hidden product', { items: [{ productId: 'hidden', tierId: 'single', count: 1 }], payment: 'cod' }],
    ['COD above the limit', { items: [{ productId: 'tulip-jar', tierId: 'single', count: 5 }], payment: 'cod' }],
    ['more than 20 of one line', { items: [{ productId: 'laddoo', tierId: 'single', count: 21 }], payment: 'cod' }],
  ])('refuses %s', async (_, body) => {
    await post(buyer.agent, '/api/orders', { ...body, address }).expect(400)
  })

  it('requires a session', async () => {
    await post(api, '/api/orders', { items: oneLaddoo, address, payment: 'cod' }).expect(401)
  })
})

describe('UPI payments', () => {
  let buyer
  let order
  beforeAll(async () => {
    buyer = await signIn(app, mailer, 'upi@test.aurie')
    const res = await post(buyer.agent, '/api/payments/order', { items: oneLaddoo, address }).expect(201)
    order = await Order.findOne({ orderNumber: res.body.orderId })
  })

  const webhook = (payload, secret = 'test-webhook-secret') => {
    const raw = JSON.stringify(payload)
    const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex')
    return api.post('/api/payments/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', sig).send(raw)
  }

  it('starts as awaiting_payment and stays out of the customer list', async () => {
    expect(order.status).toBe('awaiting_payment')
    const { body } = await buyer.agent.get('/api/orders').expect(200)
    expect(body.orders.some((o) => o.id === order.orderNumber)).toBe(false)
  })

  it('rejects a webhook with a bad signature', async () => {
    await webhook({ event: 'payment.captured' }, 'wrong-secret').expect(400)
  })

  it('a signed webhook (sent twice) marks it paid once', async () => {
    const event = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: order.razorpayOrderId } } } }
    await webhook(event).expect(200)
    await webhook(event).expect(200)
    await runDue()
    const fresh = await Order.findById(order._id)
    expect(fresh).toMatchObject({ status: 'placed', paymentStatus: 'paid', razorpayPaymentId: 'pay_1' })
    expect(fresh.statusHistory.filter((h) => h.status === 'placed')).toHaveLength(1)
    expect(vi.mocked(mailer.sendOrderConfirmationEmail)).toHaveBeenCalledTimes(1)
  })

  it('the reconcile job cancels abandoned UPI orders after 24 hours', async () => {
    const customer = await Customer.findOne({ email: 'upi@test.aurie' })
    const items = [{ productId: 'laddoo', tierId: 'single', count: 1, note: '' }]
    const stale = await createOrderFromCart({ customer, items, address, payment: 'upi' })
    const recent = await createOrderFromCart({ customer, items, address, payment: 'upi' })
    await Order.collection.updateOne({ _id: stale._id }, { $set: { createdAt: new Date(Date.now() - 25 * 3_600_000) } })
    await enqueue('orders.reconcileUnpaid')
    await runDue()
    expect((await Order.findById(stale._id)).status).toBe('cancelled')
    expect((await Order.findById(recent._id)).status).toBe('awaiting_payment')
  })
})

describe('admin', () => {
  let admin
  let orderId
  beforeAll(async () => {
    admin = supertest.agent(app)
    await post(admin, '/api/admin/login', { email: 'admin@test.aurie', password: 'admin-pass-123' }).expect(200)
    const buyer = await signIn(app, mailer, 'adminflow@test.aurie')
    const res = await post(buyer.agent, '/api/orders', { items: oneLaddoo, address, payment: 'cod' }).expect(201)
    orderId = (await Order.findOne({ orderNumber: res.body.order.id }))._id.toString()
  })

  it('rejects a wrong password', async () => {
    await post(api, '/api/admin/login', { email: 'admin@test.aurie', password: 'nope' }).expect(401)
  })

  it('does not accept a customer session on admin routes', async () => {
    const buyer = await signIn(app, mailer, 'sneaky@test.aurie')
    await api.get('/api/admin/orders').set('Authorization', `Bearer ${buyer.token}`).expect(401)
    await buyer.agent.get('/api/admin/orders').expect(401)
  })

  it('walks status forward one step at a time and emails each change', async () => {
    const patch = (body) => admin.patch(`/api/admin/orders/${orderId}`).set('Origin', ORIGIN).send(body)
    await patch({ status: 'delivered' }).expect(400)
    await patch({ status: 'confirmed' }).expect(200)
    await patch({ status: 'shipped' }).expect(400) // no tracking yet
    await patch({ status: 'shipped', courier: 'Delhivery', trackingNumber: 'TRK123456' }).expect(200)
    await patch({ status: 'cancelled' }).expect(200)
    await patch({ status: 'confirmed' }).expect(400) // cancelled is final
    await runDue()
    // Only the latest status is emailed — older queued ones see the order moved on.
    expect(vi.mocked(mailer.sendOrderStatusEmail).mock.calls.map(([, o]) => o.status)).toEqual(['cancelled'])
  })

  it('creates and edits a quote-only product without sizes', async () => {
    const created = await post(admin, '/api/admin/products', { name: 'Test Quote Box', collection: 'secret', quote: true }).expect(201)
    await admin.patch(`/api/admin/products/${created.body.product._id}`).set('Origin', ORIGIN).send({ blurb: 'x' }).expect(200)
    await post(admin, '/api/admin/products', { name: 'No Price', collection: 'festive' }).expect(400)
  })

  it('computes stats that exclude cancelled and unpaid orders', async () => {
    const { body } = await admin.get('/api/admin/stats').expect(200)
    expect(body.stats.days).toHaveLength(14)
    const counted = await Order.countDocuments({
      status: { $nin: ['cancelled', 'awaiting_payment'] },
      $or: [{ paymentStatus: 'paid' }, { 'payment.method': 'cod' }],
    })
    expect(body.stats.orderCount).toBe(counted)
  })

  it('two-factor: setup, enable, then login needs the code', async () => {
    const setup = await post(admin, '/api/admin/2fa/setup', {}).expect(200)
    expect(setup.body.qr).toMatch(/^data:image\/png;base64,/)
    await post(admin, '/api/admin/2fa/enable', { code: '000000' }).expect(400)
    await post(admin, '/api/admin/2fa/enable', { code: authenticator.generate(setup.body.secret) }).expect(200)

    const fresh = supertest.agent(app)
    const first = await post(fresh, '/api/admin/login', { email: 'admin@test.aurie', password: 'admin-pass-123' }).expect(401)
    expect(first.body.needsTotp).toBe(true)
    await post(fresh, '/api/admin/login', {
      email: 'admin@test.aurie',
      password: 'admin-pass-123',
      code: authenticator.generate(setup.body.secret),
    }).expect(200)
    await fresh.get('/api/admin/me').expect(200)
  })
})
