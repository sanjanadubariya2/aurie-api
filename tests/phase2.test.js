import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import crypto from 'node:crypto'
import mongoose from 'mongoose'

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

// Gemini is mocked: the test checks what the route does with the model's
// answer (length limits, de-duplication), not the model itself.
vi.mock('../src/services/ai.js', () => ({
  assertAi: () => {},
  generateJson: vi.fn(async () => ({
    suggestions: ['Will you marry me?', 'Will you marry me?', 'This one is far too long to fit in the beads', 'Happy 30th, Riya!', ''],
  })),
}))

const mailer = await import('../src/services/mailer.js')
const { createApp } = await import('../src/app.js')
const { connectDb, disconnectDb } = await import('../src/db.js')
const { registerJobs } = await import('../src/jobs/handlers.js')
const { runDue } = await import('../src/jobs/queue.js')
const { earliestDeliveryDate } = await import('../src/lib/createOrder.js')
const Order = (await import('../src/models/Order.js')).default
const Quote = (await import('../src/models/Quote.js')).default
const { resetDb, signIn, address, ORIGIN } = await import('./helpers.js')

const app = createApp()
const post = (agent, url, body) => agent.post(url).set('Origin', ORIGIN).send(body)
const oneLaddoo = [{ productId: 'laddoo', tierId: 'single', count: 1 }]
const daysFromNow = (n) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })

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

describe('gift options and needed-by date', () => {
  let buyer
  beforeAll(async () => {
    buyer = await signIn(app, mailer, 'gift@test.aurie')
  })

  it('adds the gift-wrap fee and stores the note', async () => {
    const res = await post(buyer.agent, '/api/orders', {
      items: oneLaddoo,
      address,
      payment: 'cod',
      gift: { wrap: true, note: 'Happy Diwali, Maa', hidePrices: true },
      neededBy: daysFromNow(10),
    }).expect(201)
    expect(res.body.order).toMatchObject({ total: 69 + 79 + 49, giftWrapFee: 49, gift: { wrap: true, note: 'Happy Diwali, Maa', hidePrices: true } })
    expect(res.body.order.neededBy).toBeTruthy()
  })

  it('refuses a needed-by date sooner than the lead time', async () => {
    const res = await post(buyer.agent, '/api/orders', { items: oneLaddoo, address, payment: 'cod', neededBy: daysFromNow(2) }).expect(400)
    expect(res.body.message).toMatch(/too soon/)
  })

  it('treats an empty needed-by as none', async () => {
    await post(buyer.agent, '/api/orders', { items: oneLaddoo, address, payment: 'cod', neededBy: '' }).expect(201)
  })

  it('exposes the earliest date helper consistently', () => {
    expect(earliestDeliveryDate()).toBe(daysFromNow(7))
  })
})

describe('custom quotes', () => {
  let buyer
  let admin
  let quoteId

  beforeAll(async () => {
    buyer = await signIn(app, mailer, 'quote@test.aurie')
    admin = supertest.agent(app)
    await post(admin, '/api/admin/login', { email: 'admin@test.aurie', password: 'admin-pass-123' }).expect(200)
  })

  it('needs a session', async () => {
    await supertest(app).post('/api/quotes').set('Origin', ORIGIN).field('details', 'A candle please, thank you').expect(401)
  })

  it('validates the request', async () => {
    const short = await buyer.agent.post('/api/quotes').set('Origin', ORIGIN).field('details', 'hi').expect(400)
    expect(short.body.message).toMatch(/a little more/)
    await buyer.agent
      .post('/api/quotes')
      .set('Origin', ORIGIN)
      .field('details', 'Proposal candle for my partner')
      .field('message', 'x'.repeat(25))
      .expect(400)
  })

  it('creates a request (multipart) and emails the customer', async () => {
    const res = await buyer.agent
      .post('/api/quotes')
      .set('Origin', ORIGIN)
      .field('productId', 'love-note')
      .field('occasion', 'Proposal')
      .field('budget', '₹1,000–2,000')
      .field('message', 'Will you marry me?')
      .field('details', 'Two jars, red beads, rose scent please.')
      .field('neededBy', daysFromNow(14))
      .expect(201)
    quoteId = res.body.quote.id
    expect(res.body.quote).toMatchObject({ status: 'new', productName: 'Love Note Reveal', message: 'Will you marry me?', price: null })
    expect(res.body.quote.number).toMatch(/^Q\d{6}$/)
    await runDue()
    expect(mailer.sendQuoteReceivedEmail).toHaveBeenCalledTimes(1)
  })

  it('cannot be paid before it is priced', async () => {
    await post(buyer.agent, `/api/payments/quote/${quoteId}`, { address }).expect(400)
  })

  it('admin prices it and the customer is emailed a pay link', async () => {
    const list = await admin.get('/api/admin/quotes?status=new').expect(200)
    expect(list.body.quotes.map((q) => q.id)).toContain(quoteId)
    await admin.patch(`/api/admin/quotes/${quoteId}`).set('Origin', ORIGIN).send({ action: 'quote', price: 0 }).expect(400)
    const res = await admin
      .patch(`/api/admin/quotes/${quoteId}`)
      .set('Origin', ORIGIN)
      .send({ action: 'quote', price: 1450, adminNote: 'Two 200g jars, gift boxed.' })
      .expect(200)
    expect(res.body.quote).toMatchObject({ status: 'quoted', price: 1450 })
    await runDue()
    expect(mailer.sendQuoteReadyEmail).toHaveBeenCalledTimes(1)
    expect(vi.mocked(mailer.sendQuoteReadyEmail).mock.calls[0][2]).toMatch(new RegExp(`/quotes/${quoteId}$`))
  })

  it('another customer cannot see or pay it', async () => {
    const other = await signIn(app, mailer, 'other@test.aurie')
    await other.agent.get(`/api/quotes/${quoteId}`).expect(404)
    await post(other.agent, `/api/payments/quote/${quoteId}`, { address }).expect(404)
  })

  it('paying creates an order at the quoted price; the webhook settles both', async () => {
    const res = await post(buyer.agent, `/api/payments/quote/${quoteId}`, { address }).expect(201)
    const order = await Order.findOne({ orderNumber: res.body.orderId })
    expect(order).toMatchObject({ total: 1450, shipping: 0, status: 'awaiting_payment' })
    expect(order.items[0]).toMatchObject({ name: 'Love Note Reveal (custom)', unitPrice: 1450, note: 'Will you marry me?' })

    const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_q1', order_id: order.razorpayOrderId } } } })
    const sig = crypto.createHmac('sha256', 'test-webhook-secret').update(raw).digest('hex')
    await supertest(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', sig).send(raw).expect(200)

    expect((await Order.findById(order._id)).status).toBe('placed')
    expect((await Quote.findById(quoteId)).status).toBe('paid')
    await post(buyer.agent, `/api/payments/quote/${quoteId}`, { address }).expect(400) // already paid
  })

  it('admin can decline a different request', async () => {
    const res = await buyer.agent.post('/api/quotes').set('Origin', ORIGIN).field('details', 'A life-size wax statue of my cat').expect(201)
    await admin.patch(`/api/admin/quotes/${res.body.quote.id}`).set('Origin', ORIGIN).send({ action: 'decline', reason: 'Too large for our moulds.' }).expect(200)
    await runDue()
    expect(mailer.sendQuoteDeclinedEmail).toHaveBeenCalledTimes(1)
  })

  it('lists the customer’s own quotes', async () => {
    const { body } = await buyer.agent.get('/api/quotes').expect(200)
    expect(body.quotes.map((q) => q.status).sort()).toEqual(['declined', 'paid'])
  })
})

describe('AI: Secret Glow message helper', () => {
  it('only returns unique suggestions that fit the beads', async () => {
    const { body } = await post(supertest(app), '/api/ai/secret-message', { occasion: 'Proposal', tone: 'romantic' }).expect(200)
    expect(body.suggestions).toEqual(['Will you marry me?', 'Happy 30th, Riya!'])
    expect(body.suggestions.every((s) => s.length <= body.maxChars)).toBe(true)
  })

  it('rejects an unknown tone', async () => {
    await post(supertest(app), '/api/ai/secret-message', { tone: 'evil' }).expect(400)
  })
})
