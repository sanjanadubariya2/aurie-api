# aurie-api

The backend for the Aurie storefront, built to the contract in `BACKEND.md`
and to the routes each `src/api/*.js` file in the frontend already calls.

## Stack

Node 20 + Express, MongoDB (Mongoose), JWT auth over email/phone OTP,
Razorpay for UPI, Resend/SMTP for email, MSG91/Fast2SMS for SMS, Cloudinary
for product images.

## Setup

```bash
npm install
cp .env.example .env   # fill in MONGODB_URI and JWT_SECRET at minimum
npm run seed            # loads the product/collection catalogue
npm run create-admin -- you@example.com "a strong password"
npm run dev
```

The server listens on `PORT` (default `4000`) and mounts every route under
`/api`, e.g. `http://localhost:4000/api/products`. Point the frontend at it
by setting `VITE_API_URL=http://localhost:4000/api` in
`aurie-storefront/.env`.

### What works with zero external accounts

`MONGODB_URI` and `JWT_SECRET` are the only two required env vars. Without
the rest configured:

- **Email/SMS OTP** codes are printed to the server console instead of sent
  (`[mailer:dev] ...` / `[sms:dev] ...`) — sign-in works end to end locally.
- **Razorpay** falls back to a fake order id so the UPI flow is clickable;
  no real payment happens and the signature check always passes.
- **Cloudinary** uploads return a 503 until configured — everything else
  (typing a product's fields, its price tiers) works without it.

Fill in the real keys in `.env` when you have them; nothing else changes.

## Auth model

- **Customers** sign in with an email OTP only — first verified code creates
  the account. Sending is limited per email (5/hour) and loosely per IP, and
  each code allows 5 guesses. Phone OTP routes exist but checkout does not use
  them until an SMS/WhatsApp provider is configured.
- **Email** goes out through Resend or SMTP (`EMAIL_PROVIDER` picks the first
  choice). If both are configured and the first fails, the other is tried.
  SMTP mail is sent from `SMTP_USER`, since Gmail rejects other From addresses.
- **Admins** get a password (`npm run create-admin`) and sign in at
  `POST /api/admin/login`. Every other `/api/admin/*` route requires that
  token *and* `role: 'admin'`.
- The frontend currently stores the JWT in `localStorage` and sends
  `Authorization: Bearer <token>` — `requireAuth` accepts that, and also
  reads an httpOnly `token` cookie if you switch to that later (see
  `BACKEND.md` §5 for the trade-off).

## Orders and payment status

- COD: `POST /api/orders` → `placed` immediately, confirmation email sent.
- UPI: `POST /api/payments/order` → `awaiting_payment` (hidden from the
  customer's list and the admin queue) → `placed` once `/payments/verify` or the
  Razorpay webhook confirms it. The confirmation email is sent exactly once.
- Admin status changes are validated here, not just in the UI: one step forward
  at a time, courier + tracking required from `shipped`, `cancelled` is final.
- `npm run fix-unpaid-upi` lists (and with `-- --apply` fixes) old unpaid UPI
  orders that were saved as `placed` before `awaiting_payment` existed.

## Money

`POST /api/orders` re-prices every line from the database — the client's
`total` is accepted in the request but never read; Zod strips it before it
reaches Mongoose. `POST /api/payments/upi` does the same for the Razorpay
order amount. Don't change this without re-reading `BACKEND.md` §3/§6.

## Admin

- `GET/PATCH /api/admin/orders` — list and update status/courier/tracking.
  A status change fires a best-effort confirmation email (never blocks the
  update if the email fails).
- `GET/POST/PATCH/DELETE /api/admin/products` — catalogue CRUD. Hiding sets
  `active: false`; delete is permanent, which is safe because past orders keep
  their own name/image/price snapshot. Quote-only products (`quote: true`)
  need no sizes.
- `GET /api/admin/collections` — the collection list the product form uses.
- `POST /api/admin/products/:id/image` — multipart `image` field, uploads to
  Cloudinary and replaces the product's image.
- `GET /api/admin/stats` — 14-day revenue (IST days; cancelled and unpaid UPI
  excluded), order count, COD share and top 5 products by units.

## Before going live

See the checklist in `BACKEND.md` §8 — CORS lock-down, Atlas backups,
Razorpay webhook registration, and TOTP on the admin account are all still
worth doing before real money moves through this.
