import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import supertest from 'supertest'
import { vi } from 'vitest'
import Product from '../src/models/Product.js'
import Collection from '../src/models/Collection.js'
import Customer from '../src/models/Customer.js'

export const ORIGIN = 'http://localhost:5173'
export const address = {
  fullName: 'Test Person',
  phone: '9876543210',
  line1: '1 Test Street',
  city: 'Mumbai',
  state: 'Maharashtra',
  pincode: '400001',
}

/** Wipes the test database and loads a small, known catalogue. */
export async function resetDb() {
  await mongoose.connection.db.dropDatabase()
  await Promise.all(mongoose.modelNames().map((m) => mongoose.model(m).syncIndexes()))
  await Collection.create([
    { slug: 'festive', name: 'Festive', order: 0 },
    { slug: 'secret', name: 'Secret Glow', order: 1 },
  ])
  await Product.create([
    {
      slug: 'laddoo',
      name: 'Motichoor Laddoo',
      collection_: 'festive',
      tiers: [
        { id: 'single', label: 'Single', qty: 1, price: 69 },
        { id: 'combo', label: 'Box of 4', qty: 4, price: 240 },
      ],
    },
    { slug: 'tulip-jar', name: 'Tulip Jar', collection_: 'festive', tiers: [{ id: 'single', label: 'Single', qty: 1, price: 499 }] },
    { slug: 'love-note', name: 'Love Note Reveal', collection_: 'secret', quote: true },
    {
      slug: 'hidden',
      name: 'Hidden One',
      collection_: 'festive',
      active: false,
      tiers: [{ id: 'single', label: 'Single', qty: 1, price: 10 }],
    },
  ])
  await Customer.create({ email: 'admin@test.aurie', role: 'admin', passwordHash: await bcrypt.hash('admin-pass-123', 4) })
}

/** Signs a customer in through the real OTP flow; returns a cookie-holding agent. */
export async function signIn(app, mailer, email = 'buyer@test.aurie') {
  const agent = supertest.agent(app)
  await agent.post('/api/auth/email/otp').set('Origin', ORIGIN).send({ email }).expect(200)
  const code = vi.mocked(mailer.sendOtpEmail).mock.calls.filter(([to]) => to === email).at(-1)[1]
  const res = await agent.post('/api/auth/email/verify').set('Origin', ORIGIN).send({ email, code }).expect(200)
  return { agent, token: res.body.token, customer: res.body.customer, res }
}
