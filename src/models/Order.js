import mongoose from 'mongoose'

// Snapshot at the moment of purchase — never a live reference to Product.
// If a price changes next week, orders placed today must still show today's price.
const lineSchema = new mongoose.Schema(
  {
    key: String, // `${productId}::${tierId}::${note}` — mirrors the frontend cart line key
    productId: String,
    name: String,
    image: String,
    tierId: String,
    tierLabel: String,
    unitPrice: Number,
    count: { type: Number, min: 1 },
    note: String,
  },
  { _id: false },
)

const addressSchema = new mongoose.Schema(
  {
    fullName: String,
    phone: String,
    line1: String,
    line2: String,
    city: String,
    state: String,
    pincode: String,
    notes: String,
  },
  { _id: false },
)

export const STATUS_FLOW = ['placed', 'confirmed', 'shipped', 'out_for_delivery', 'delivered']
// `awaiting_payment` is a UPI order whose Razorpay payment has not been
// verified yet. It is deliberately outside STATUS_FLOW: it never shows in the
// customer's order list or the admin queue until the money is confirmed, so an
// abandoned payment can no longer look like a real order that needs pouring.
export const STATUSES = [...STATUS_FLOW, 'cancelled', 'awaiting_payment']
/** Statuses that need a courier + tracking number before they can be set. */
export const TRACKED_STATUSES = ['shipped', 'out_for_delivery', 'delivered']

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, unique: true }, // AUR123456
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    items: [lineSchema],
    address: addressSchema,
    subtotal: Number,
    shipping: Number,
    giftWrapFee: { type: Number, default: 0 },
    // Gift options chosen at checkout.
    gift: {
      wrap: { type: Boolean, default: false },
      note: String, // printed on a card in the box
      hidePrices: { type: Boolean, default: false }, // no prices on the packing slip
    },
    // The date the customer needs it by (an occasion), if they gave one.
    neededBy: Date,
    // Set when this order pays for a custom quote.
    quote: { type: mongoose.Schema.Types.ObjectId, ref: 'Quote' },
    total: { type: Number, required: true },
    payment: {
      method: { type: String, enum: ['upi', 'cod'], required: true },
    },
    // Razorpay's own view of the money — separate from `status` below, which
    // is the fulfilment/delivery lifecycle. A COD order can be `placed` while
    // staying `paymentStatus: 'pending'` forever; that's expected, COD never
    // touches this.
    paymentStatus: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
    razorpayOrderId: { type: String, index: true },
    razorpayPaymentId: String,
    status: { type: String, enum: STATUSES, default: 'placed', index: true },
    statusHistory: [{ status: String, at: Date, by: String }],
    courier: String,
    trackingNumber: String,
    expectedBy: Date,
    // Set once the "order confirmed" email has gone out, so the Razorpay
    // verify call and the webhook (which can both land) never send it twice.
    confirmationSentAt: Date,
  },
  { timestamps: true },
)

/** Shapes a document into what Checkout.jsx / Orders.jsx / OrderTimeline.jsx expect. */
export function toPublicOrder(doc) {
  const o = doc.toObject ? doc.toObject() : doc
  return {
    id: o.orderNumber,
    createdAt: o.createdAt,
    items: o.items,
    address: o.address,
    payment: o.payment.method, // the frontend reads `order.payment` as a plain 'upi' | 'cod' string
    paymentStatus: o.paymentStatus || 'pending',
    subtotal: o.subtotal,
    shipping: o.shipping,
    giftWrapFee: o.giftWrapFee || 0,
    gift: o.gift?.wrap || o.gift?.note ? { wrap: Boolean(o.gift.wrap), note: o.gift.note || '', hidePrices: Boolean(o.gift.hidePrices) } : null,
    neededBy: o.neededBy || null,
    total: o.total,
    status: o.status,
    trackingNumber: o.trackingNumber || null,
    courier: o.courier || null,
    expectedBy: o.expectedBy,
  }
}

export default mongoose.model('Order', orderSchema)
