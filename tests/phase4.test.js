import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import supertest from 'supertest'
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

// The model is mocked; tests check what the API does with its answers.
const aiAnswers = []
vi.mock('../src/services/ai.js', () => ({
  assertAi: () => {},
  generateJson: vi.fn(async () => aiAnswers.shift() || {}),
}))

const mailer = await import('../src/services/mailer.js')
const { createApp } = await import('../src/app.js')
const { connectDb, disconnectDb } = await import('../src/db.js')
const { registerJobs } = await import('../src/jobs/handlers.js')
const { runDue } = await import('../src/jobs/queue.js')
const Order = (await import('../src/models/Order.js')).default
const Coupon = (await import('../src/models/Coupon.js')).default
const Customer = (await import('../src/models/Customer.js')).default
const Product = (await import('../src/models/Product.js')).default
const Job = (await import('../src/models/Job.js')).default
const { resetDb, signIn, address, ORIGIN } = await import('./helpers.js')

const app = createApp()
const post = (agent, url, body) => agent.post(url).set('Origin', ORIGIN).send(body)
const put = (agent, url, body) => agent.put(url).set('Origin', ORIGIN).send(body)
const combo = (count = 1) => [{ productId: 'laddoo', tierId: 'combo', count }] // ₹240 each
let owner

beforeAll(async () => {
  await connectDb()
  registerJobs()
  await resetDb()
  owner = supertest.agent(app)
  await post(owner, '/api/admin/login', { email: 'admin@test.aurie', password: 'admin-pass-123' }).expect(200)
})
afterAll(async () => {
  await mongoose.connection.db.dropDatabase()
  await disconnectDb()
})

describe('coupons', () => {
  beforeAll(async () => {
    await post(owner, '/api/admin/coupons', { code: 'diwali10', type: 'percent', value: 10, maxDiscount: 50, minSubtotal: 300 }).expect(201)
    await post(owner, '/api/admin/coupons', { code: 'WELCOME', type: 'flat', value: 100, firstOrderOnly: true }).expect(201)
    await post(owner, '/api/admin/coupons', { code: 'TOOMUCH', type: 'percent', value: 95 }).expect(400)
  })

  it('previews a percent code with its cap and minimum', async () => {
    const { agent } = await signIn(app, mailer, 'coupon1@test.aurie')
    const low = await post(agent, '/api/account/coupon', { code: 'DIWALI10', items: combo(1) }).expect(400)
    expect(low.body.message).toMatch(/Add ₹60 more/)
    const ok = await post(agent, '/api/account/coupon', { code: 'diwali10', items: combo(2) }).expect(200)
    expect(ok.body).toMatchObject({ code: 'DIWALI10', discount: 48 }) // 10% of 480
    const capped = await post(agent, '/api/account/coupon', { code: 'DIWALI10', items: combo(4) }).expect(200)
    expect(capped.body.discount).toBe(50)
  })

  it('applies the discount to the order total (free delivery judged before the discount)', async () => {
    const { agent } = await signIn(app, mailer, 'coupon2@test.aurie')
    const res = await post(agent, '/api/orders', { items: combo(5), address, payment: 'cod', couponCode: 'DIWALI10' }).expect(201)
    expect(res.body.order).toMatchObject({ discount: 50, couponCode: 'DIWALI10', total: 1200 - 50 }) // 1200 ≥ 999 -> free delivery
    expect((await Coupon.findOne({ code: 'DIWALI10' })).used).toBe(1)
  })

  it('first-order and once-per-customer rules hold', async () => {
    const { agent } = await signIn(app, mailer, 'coupon3@test.aurie')
    await post(agent, '/api/orders', { items: combo(1), address, payment: 'cod', couponCode: 'WELCOME' }).expect(201)
    const again = await post(agent, '/api/orders', { items: combo(1), address, payment: 'cod', couponCode: 'WELCOME' }).expect(400)
    expect(again.body.message).toMatch(/first order only|already used/)
  })

  it('an unpaid UPI order does not use up the code', async () => {
    const { agent } = await signIn(app, mailer, 'coupon4@test.aurie')
    const before = (await Coupon.findOne({ code: 'DIWALI10' })).used
    await post(agent, '/api/payments/order', { items: combo(2), address, couponCode: 'DIWALI10' }).expect(201)
    expect((await Coupon.findOne({ code: 'DIWALI10' })).used).toBe(before)
  })

  it('rejects unknown and expired codes', async () => {
    const { agent } = await signIn(app, mailer, 'coupon5@test.aurie')
    await Coupon.create({ code: 'OLD', type: 'flat', value: 50, endsAt: new Date(Date.now() - 86_400_000) })
    await post(agent, '/api/account/coupon', { code: 'NOPE', items: combo(1) }).expect(400)
    await post(agent, '/api/account/coupon', { code: 'OLD', items: combo(1) }).expect(400)
  })
})

describe('account', () => {
  let agent
  beforeAll(async () => {
    agent = (await signIn(app, mailer, 'account@test.aurie')).agent
  })

  it('saves addresses with exactly one default', async () => {
    const two = [address, { ...address, fullName: 'Second', city: 'Pune', pincode: '411004' }]
    const { body } = await put(agent, '/api/account/addresses', { addresses: two }).expect(200)
    expect(body.addresses.map((a) => a.isDefault)).toEqual([true, false])
    await put(agent, '/api/account/addresses', { addresses: Array(6).fill(address) }).expect(400)
  })

  it('keeps a wishlist and a name', async () => {
    await put(agent, '/api/account/wishlist', { slugs: ['laddoo', 'laddoo', 'tulip-jar'] }).expect(200)
    const { body } = await agent.patch('/api/account').set('Origin', ORIGIN).send({ name: 'Riya Shah' }).expect(200)
    expect(body.wishlist).toEqual(['laddoo', 'tulip-jar'])
    expect(body.customer.name).toBe('Riya Shah')
  })

  it('abandoned cart: reminds once, a day later, only if nothing was ordered', async () => {
    await put(agent, '/api/account/cart', { lines: [{ productId: 'tulip-jar', tierId: 'single', count: 1 }] }).expect(200)
    const job = await Job.findOne({ type: 'email.abandonedCart', status: 'pending' })
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000)
    // Fast-forward: the cart has sat for a day and the job is due.
    await Customer.updateOne({ email: 'account@test.aurie' }, { $set: { 'cart.updatedAt': new Date(Date.now() - 25 * 3_600_000) } })
    await Job.updateOne({ _id: job._id }, { $set: { runAt: new Date() } })
    await runDue()
    expect(mailer.sendAbandonedCartEmail).toHaveBeenCalledTimes(1)
    expect(vi.mocked(mailer.sendAbandonedCartEmail).mock.calls[0][1][0]).toMatchObject({ name: 'Tulip Jar', unitPrice: 499 })
  })
})

describe('reviews', () => {
  let buyer
  let orderNumber
  beforeAll(async () => {
    buyer = (await signIn(app, mailer, 'reviewer@test.aurie')).agent
    const res = await post(buyer, '/api/orders', { items: [{ productId: 'tulip-jar', tierId: 'single', count: 1 }], address, payment: 'cod' }).expect(201)
    orderNumber = res.body.order.id
  })

  it('only after delivery', async () => {
    const out = await buyer.post('/api/account/reviews').set('Origin', ORIGIN).field('orderNumber', orderNumber).field('productId', 'tulip-jar').field('rating', '5').expect(400)
    expect(out.body.message).toMatch(/delivered/)
  })

  it('delivery queues a review request for 3 days later', async () => {
    const id = (await Order.findOne({ orderNumber }))._id
    const patch = (body) => owner.patch(`/api/admin/orders/${id}`).set('Origin', ORIGIN).send(body).expect(200)
    await patch({ status: 'confirmed' })
    await patch({ status: 'shipped', courier: 'Delhivery', trackingNumber: 'TRK999999' })
    await patch({ status: 'out_for_delivery' })
    await patch({ status: 'delivered' })
    const job = await Job.findOne({ type: 'email.reviewRequest' })
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now() + 2.9 * 86_400_000)
    const { body } = await buyer.get('/api/account/reviewable').expect(200)
    expect(body.items).toEqual([expect.objectContaining({ orderNumber, productId: 'tulip-jar' })])
  })

  it('one review per item; approval updates the product rating and public list', async () => {
    const send = () =>
      buyer.post('/api/account/reviews').set('Origin', ORIGIN).field('orderNumber', orderNumber).field('productId', 'tulip-jar').field('rating', '4').field('text', 'Lovely colours.')
    const first = await send().expect(201)
    expect(first.body.review.author).toBe('Test P.')
    await send().expect(409)

    let pub = await supertest(app).get('/api/products/tulip-jar/reviews').expect(200)
    expect(pub.body.reviews).toHaveLength(0) // pending
    const { body } = await owner.get('/api/admin/reviews').expect(200)
    await owner.patch(`/api/admin/reviews/${body.reviews[0]._id}`).set('Origin', ORIGIN).send({ status: 'approved' }).expect(200)
    pub = await supertest(app).get('/api/products/tulip-jar/reviews').expect(200)
    expect(pub.body.summary).toEqual({ average: 4, count: 1 })
    expect((await Product.findOne({ slug: 'tulip-jar' })).rating).toMatchObject({ average: 4, count: 1 })
    const { body: list } = await supertest(app).get('/api/products').expect(200)
    expect(list.products.find((p) => p.id === 'tulip-jar').rating).toEqual({ average: 4, count: 1 })
  })
})

describe('AI helpers (model mocked)', () => {
  it('gift finder keeps only real products', async () => {
    aiAnswers.push({ intro: 'Two ideas.', picks: [{ id: 'tulip-jar', reason: 'Bright' }, { id: 'made-up', reason: 'x' }, { id: 'hidden', reason: 'inactive' }] })
    const { body } = await post(supertest(app), '/api/ai/gift-finder', { query: 'Gift for my mum under 600' }).expect(200)
    expect(body.picks).toEqual([{ id: 'tulip-jar', reason: 'Bright' }])
  })

  it('voice note parsing never passes through junk', async () => {
    aiAnswers.push({ orderNumber: 'AUR 123456', status: 'teleported', courier: 'Delhivery', trackingNumber: 'AB 12-34' })
    const { body } = await post(owner, '/api/admin/ai/parse-update', { transcript: 'AUR one two three... shipped' }).expect(200)
    expect(body).toEqual({ orderNumber: 'AUR123456', status: '', courier: 'Delhivery', trackingNumber: 'AB1234' })
  })

  it('weekly summary is built from real numbers', async () => {
    aiAnswers.push({ bullets: ['A point'] })
    const { body } = await owner.get('/api/admin/ai/weekly-summary').expect(200)
    expect(body.bullets).toEqual(['A point'])
    expect(body.facts.ordersThisWeek).toBe(await Order.countDocuments({ status: { $nin: ['cancelled', 'awaiting_payment'] } }))
  })
})
