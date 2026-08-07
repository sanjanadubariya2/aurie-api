# Backend guide — Aurie

Everything the storefront and admin need, in the order worth building it.
The frontend already calls these routes; each `src/api/*.js` file lists its
contract at the top.

---

## 1. Stack

| Piece      | Pick                        | Why                                                                 |
| ---------- | --------------------------- | ------------------------------------------------------------------- |
| Runtime    | Node 20 + Express           | Same language as the frontend, fastest for you to move in           |
| Database   | MongoDB Atlas + Mongoose    | Orders are document-shaped; the free M0 tier is enough for launch   |
| Email      | Resend or Nodemailer + SMTP | Resend has a cleaner API; Nodemailer works with any Gmail/Zoho box  |
| SMS        | MSG91 or Fast2SMS           | Cheaper than Twilio in India and both handle DLT for you            |
| Payments   | Razorpay                    | UPI, cards, netbanking in one integration                           |
| Images     | Cloudinary                  | Free tier, resizes on the fly                                       |
| Hosting    | Railway                     | You already deploy there                                            |

**On Postgres instead:** if you prefer relational, use Neon + Prisma. Same
routes, same logic, different models file. Orders benefit slightly from
Mongo here because each order embeds a snapshot of its line items — see §3.

**On the SMS gap:** transactional SMS in India requires DLT registration
with a telecom operator (entity ID + approved template). It takes a few
working days and needs business documents. Start that on day one; the rest of
the backend does not block on it. Until it clears, verify phone numbers with a
WhatsApp message or skip phone OTP and rely on email OTP alone.

---

## 2. Project shape

```
aurie-api/
├── src/
│   ├── server.js            express app, cors, helmet, rate limits
│   ├── db.js                mongoose connection
│   ├── models/
│   │   ├── Customer.js
│   │   ├── Otp.js
│   │   ├── Product.js
│   │   └── Order.js
│   ├── middleware/
│   │   ├── requireAuth.js
│   │   ├── requireAdmin.js
│   │   └── errorHandler.js
│   ├── routes/
│   │   ├── auth.js
│   │   ├── products.js
│   │   ├── orders.js
│   │   ├── payments.js
│   │   └── admin.js
│   ├── services/
│   │   ├── otp.js           generate, hash, verify
│   │   ├── mailer.js
│   │   ├── sms.js
│   │   └── razorpay.js
│   └── seed.js              imports the frontend's products.js
└── .env
```

---

## 3. Database

### Connecting

```js
// src/db.js
import mongoose from 'mongoose'

export async function connectDb() {
  await mongoose.connect(process.env.MONGODB_URI)
  console.log('db connected')
}
```

Create a free cluster at Atlas, add a database user, and allow-list
`0.0.0.0/0` only if Railway does not give you a static IP. The URI goes in
`MONGODB_URI` — never in the repo.

### Models

```js
// src/models/Customer.js
const customerSchema = new mongoose.Schema({
  email:         { type: String, required: true, unique: true, lowercase: true, trim: true },
  name:          String,
  phone:         String,
  phoneVerified: { type: Boolean, default: false },
  role:          { type: String, enum: ['customer', 'admin'], default: 'customer' },
  passwordHash:  String,   // admins only — customers never get one
  addresses:     [{ fullName: String, phone: String, line1: String, line2: String,
                    city: String, state: String, pincode: String, isDefault: Boolean }],
}, { timestamps: true })
```

```js
// src/models/Product.js
const tierSchema = new mongoose.Schema({
  id:    { type: String, enum: ['single', 'double', 'combo'], required: true },
  label: String,
  qty:   Number,
  price: { type: Number, required: true, min: 0 },
}, { _id: false })

const productSchema = new mongoose.Schema({
  slug:       { type: String, required: true, unique: true },  // "laddoo"
  name:       { type: String, required: true },
  collection_: { type: String, required: true },  // `collection` is reserved in Mongoose
  image:      String,
  scent:      String,
  burn:       String,
  blurb:      String,
  badge:      String,
  quote:      { type: Boolean, default: false },
  active:     { type: Boolean, default: true },
  tiers:      [tierSchema],
}, { timestamps: true })
```

```js
// src/models/Order.js
const lineSchema = new mongoose.Schema({
  productId: String,
  name:      String,      // snapshot — see the note below
  image:     String,
  tierId:    String,
  tierLabel: String,
  unitPrice: Number,
  count:     { type: Number, min: 1 },
  note:      String,
}, { _id: false })

const orderSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true, unique: true },   // AUR123456
  customer:    { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
  items:       [lineSchema],
  address:     { /* same fields as Customer.addresses */ },
  subtotal:    Number,
  shipping:    Number,
  total:       { type: Number, required: true },
  payment: {
    method:    { type: String, enum: ['upi', 'cod'], required: true },
    status:    { type: String, enum: ['pending', 'paid', 'failed', 'collected'], default: 'pending' },
    razorpayOrderId:   String,
    razorpayPaymentId: String,
  },
  status:         { type: String, enum: ['placed','confirmed','shipped','out_for_delivery','delivered','cancelled'], default: 'placed', index: true },
  statusHistory:  [{ status: String, at: Date, by: String }],
  courier:        String,
  trackingNumber: String,
  expectedBy:     Date,
}, { timestamps: true })
```

**Why line items are snapshots.** When you raise the Peony Bloom from ₹249 to
₹279, orders placed last week must still show ₹249. Copy the name, image and
price into the order at checkout instead of referencing the product. This is
the single most common bug in first e-commerce builds.

**Trust the server on price.** The client sends product ids and tier ids, not
amounts. Look every price up from the database and compute the total there.
Anyone can edit a request body.

### Seeding

`src/data/products.js` in the frontend is already the exact shape. Import it in
`seed.js`, map `collection` to `collection_` and `id` to `slug`, and
`insertMany`. Run once, then manage everything from the admin panel.

---

## 4. OTP authentication

### Rules that matter

1. **Never store the code in plain text.** Hash it like a password.
2. **Expire it.** Ten minutes, enforced by a TTL index so Mongo deletes the row itself.
3. **Cap attempts.** Five wrong tries and that OTP is dead. Otherwise six digits is only a million guesses.
4. **Rate limit requests.** Three sends per email per fifteen minutes, or your SMS bill becomes someone else's toy.
5. **Same response either way.** Return the same body whether the email exists or not, so the endpoint cannot be used to discover who has an account.

### Model

```js
// src/models/Otp.js
const otpSchema = new mongoose.Schema({
  identifier: { type: String, required: true, index: true },  // email or phone
  channel:    { type: String, enum: ['email', 'sms'], required: true },
  codeHash:   { type: String, required: true },
  attempts:   { type: Number, default: 0 },
  expiresAt:  { type: Date, required: true },
}, { timestamps: true })

// Mongo removes the document the moment expiresAt passes
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
```

### Service

```js
// src/services/otp.js
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import Otp from '../models/Otp.js'

const TTL_MINUTES = 10
const MAX_ATTEMPTS = 5

export async function issueOtp(identifier, channel) {
  // crypto.randomInt, not Math.random — this is a credential
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')

  await Otp.deleteMany({ identifier })          // one live code at a time
  await Otp.create({
    identifier,
    channel,
    codeHash: await bcrypt.hash(code, 10),
    expiresAt: new Date(Date.now() + TTL_MINUTES * 60_000),
  })

  return code   // hand to the mailer or SMS service, never to the response
}

export async function verifyOtp(identifier, code) {
  const record = await Otp.findOne({ identifier })
  if (!record) throw new HttpError(400, 'That code has expired. Ask for a new one.')

  if (record.attempts >= MAX_ATTEMPTS) {
    await record.deleteOne()
    throw new HttpError(429, 'Too many tries. Ask for a new code.')
  }

  const ok = await bcrypt.compare(code, record.codeHash)
  if (!ok) {
    record.attempts += 1
    await record.save()
    throw new HttpError(400, 'That code did not match. Ask for a new one.')
  }

  await record.deleteOne()   // single use
  return true
}
```

### Routes

```js
// src/routes/auth.js
import rateLimit from 'express-rate-limit'

const otpLimiter = rateLimit({ windowMs: 15 * 60_000, max: 3 })

router.post('/auth/email/otp', otpLimiter, async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim()
  if (!isEmail(email)) return res.status(400).json({ message: 'Enter a valid email address' })

  const code = await issueOtp(email, 'email')
  await sendOtpEmail(email, code)

  res.json({ sent: true })     // identical whether or not the account exists
})

router.post('/auth/email/verify', async (req, res) => {
  const { email, code } = req.body
  await verifyOtp(email.toLowerCase().trim(), code)

  // First verified sign-in creates the account. No separate signup flow.
  const customer = await Customer.findOneAndUpdate(
    { email: email.toLowerCase().trim() },
    { $setOnInsert: { email: email.toLowerCase().trim(), role: 'customer' } },
    { upsert: true, new: true },
  )

  const token = signToken(customer)
  res.json({ token, customer: publicCustomer(customer) })
})
```

Phone OTP is the same service with `channel: 'sms'`, except it runs behind
`requireAuth` and sets `phoneVerified` instead of issuing a token — the person
is already signed in by then, they are proving the delivery number works.

---

## 5. JWT

### Signing

```js
// src/services/token.js
import jwt from 'jsonwebtoken'

export const signToken = (customer) =>
  jwt.sign(
    { sub: customer._id.toString(), role: customer.role },
    process.env.JWT_SECRET,
    { expiresIn: '30d', issuer: 'aurie' },
  )
```

Keep the payload thin — an id and a role. Never put the email, address or
anything private in it; a JWT is signed, not encrypted, and anyone holding it
can read the contents.

Generate the secret with `openssl rand -base64 48` and put it in `.env`.

### Middleware

```js
// src/middleware/requireAuth.js
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.cookies?.token
  if (!token) return res.status(401).json({ message: 'Sign in to continue' })

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    req.customer = await Customer.findById(payload.sub)
    if (!req.customer) return res.status(401).json({ message: 'Sign in to continue' })
    next()
  } catch {
    res.status(401).json({ message: 'Your session expired. Sign in again.' })
  }
}
```

```js
// src/middleware/requireAdmin.js
export function requireAdmin(req, res, next) {
  if (req.customer?.role !== 'admin') {
    return res.status(403).json({ message: 'Not allowed' })   // 403, not 404
  }
  next()
}
```

Mount it on the whole admin router, not per route — one forgotten route is a
public admin panel:

```js
app.use('/api/admin', requireAuth, requireAdmin, adminRouter)
```

### Where to keep the token

The frontend currently stores it in `localStorage` and sends
`Authorization: Bearer`. That is the simplest thing that works and is fine for
launch, but it is readable by any script that gets injected into your page.

**The safer version** is an httpOnly cookie, which JavaScript cannot read:

```js
res.cookie('token', token, {
  httpOnly: true,
  secure: true,            // requires https
  sameSite: 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000,
})
```

To switch, drop the `Authorization` header from `src/api/client.js` and add
`credentials: 'include'` to every fetch, then set CORS to
`{ origin: 'https://yourdomain.com', credentials: true }`. The rest of the app
does not change. Worth doing before you take real money, and `sameSite: 'lax'`
covers ordinary CSRF for this shape of app.

### Admin login

Admins get a password, not an OTP — they sign in several times a day.

```js
router.post('/admin/login', loginLimiter, async (req, res) => {
  const admin = await Customer.findOne({ email: req.body.email.toLowerCase(), role: 'admin' })
  const ok = admin && await bcrypt.compare(req.body.password, admin.passwordHash)
  // One message for both failures — do not reveal which admin emails exist
  if (!ok) return res.status(401).json({ message: 'That email and password do not match.' })

  res.json({ token: signToken(admin), admin: publicCustomer(admin) })
})
```

Create the first admin with a one-off script, not a public route. Add TOTP
two-factor later — this panel can change prices and read every customer's
address.

---

## 6. Payments

Never trust the client to say an order was paid. The flow:

1. Client posts the cart to `POST /orders`. Server prices it, saves it with
   `payment.status: 'pending'`, and for UPI creates a Razorpay order.
2. Server returns `razorpayOrderId` and the **public** key id.
3. Client opens Razorpay checkout. The customer pays.
4. Razorpay returns a signature. Server verifies it before marking paid.

```js
// src/routes/payments.js
import crypto from 'node:crypto'

router.post('/payments/verify', requireAuth, async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, signature, orderId } = req.body

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex')

  if (expected !== signature) {
    return res.status(400).json({ message: 'Payment could not be verified' })
  }

  const order = await Order.findOneAndUpdate(
    { _id: orderId, customer: req.customer._id },
    { 'payment.status': 'paid', 'payment.razorpayPaymentId': razorpayPaymentId },
    { new: true },
  )
  res.json({ order })
})
```

Also register the Razorpay **webhook** for `payment.captured`. If the customer
closes the tab after paying, the webhook is the only thing that tells you money
arrived. `RAZORPAY_KEY_SECRET` never leaves the server.

For cash on delivery, skip all of this and set
`payment.status: 'collected'` when the admin marks the order delivered.

---

## 7. Status updates and notifications

One route drives the customer's whole tracking experience:

```js
router.patch('/admin/orders/:id', async (req, res) => {
  const { status, courier, trackingNumber } = req.body
  const order = await Order.findById(req.params.id)

  order.status = status
  if (courier) order.courier = courier
  if (trackingNumber) order.trackingNumber = trackingNumber
  order.statusHistory.push({ status, at: new Date(), by: req.customer.email })
  await order.save()

  // Fire and forget — a failed email must not fail the status update
  notifyCustomer(order).catch(console.error)

  res.json({ order })
})
```

Keep the status strings identical to `STATUS_FLOW` in
`src/api/orders.js`. The customer timeline renders straight off them, so a typo
on the server shows up as a broken tracking page.

---

## 8. Before you go live

- [ ] `.env` in `.gitignore`, and no secret ever hardcoded
- [ ] `helmet()` and CORS locked to your own domain
- [ ] Rate limits on both OTP routes and admin login
- [ ] Prices and totals computed server-side from the database
- [ ] Every `/admin` route behind `requireAuth` **and** `requireAdmin`
- [ ] Zod or Joi validating request bodies — never pass `req.body` to Mongoose
- [ ] Razorpay signature verified, webhook registered
- [ ] Atlas backups on
- [ ] Order numbers not sequential (AUR100001 tells competitors your volume)

---

## 9. Build order

| Days  | What                                                                       |
| ----- | -------------------------------------------------------------------------- |
| 1     | Express skeleton, Atlas cluster, models, seed products. Start DLT and Razorpay KYC the same day — both have waiting periods you do not control. |
| 2     | Email OTP end to end: issue, send, verify, JWT back. Point the frontend at it and delete demo mode from the email flow. |
| 3     | `GET /products` and `/collections`. The shop page now runs on the database. |
| 4     | `POST /orders` with server-side pricing, `GET /orders`. Checkout works, cash on delivery only. |
| 5     | Phone OTP, or a WhatsApp fallback if DLT has not cleared.                   |
| 6–7   | Razorpay: order creation, signature verification, webhook.                  |
| 8     | Admin login, seed the admin account, `/admin/orders` and the PATCH route.   |
| 9     | `/admin/products` CRUD and Cloudinary uploads.                              |
| 10    | `/admin/stats` aggregation pipeline.                                        |
| 11    | Notification emails and SMS on every status change.                         |
| 12    | Deploy to Railway, point the domain, test a real ₹1 UPI payment.            |
| 13–14 | Buffer. Something will be waiting on someone else's approval.               |

Build in that order for a reason: each step leaves the app in a working state.
After day 4 you could take cash-on-delivery orders for real, which means if
anything slips you still have a shop.
