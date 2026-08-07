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
export const STATUSES = [...STATUS_FLOW, 'cancelled']

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, unique: true }, // AUR123456
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    items: [lineSchema],
    address: addressSchema,
    subtotal: Number,
    shipping: Number,
    total: { type: Number, required: true },
    payment: {
      method: { type: String, enum: ['upi', 'cod'], required: true },
      status: { type: String, enum: ['pending', 'paid', 'failed', 'collected'], default: 'pending' },
      razorpayOrderId: String,
      razorpayPaymentId: String,
    },
    status: { type: String, enum: STATUSES, default: 'placed', index: true },
    statusHistory: [{ status: String, at: Date, by: String }],
    courier: String,
    trackingNumber: String,
    expectedBy: Date,
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
    total: o.total,
    status: o.status,
    trackingNumber: o.trackingNumber || null,
    courier: o.courier || null,
    expectedBy: o.expectedBy,
  }
}

export default mongoose.model('Order', orderSchema)
