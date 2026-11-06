import mongoose from 'mongoose'

/**
 * A custom-order request (Secret Glow wording, Luxe hampers, "make this from my
 * photo"). Lifecycle:
 *   new -> quoted (admin sets a price) -> paid (customer paid via Razorpay)
 *       \-> declined (admin)       quoted -> expired (validUntil passed)
 * Paying a quote creates a normal Order, so fulfilment, tracking and emails
 * work exactly like any other order.
 */
export const QUOTE_STATUSES = ['new', 'quoted', 'paid', 'declined', 'expired']

const quoteSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true }, // Q123456 — what the customer quotes back to us
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    productId: String, // the catalogue item it started from, if any (slug)
    productName: String,
    occasion: String,
    neededBy: Date,
    budget: String, // a band like "₹1,000–2,000" — a hint, not a price
    message: String, // Secret Glow wording, if any
    details: { type: String, required: true },
    images: [{ url: String, publicId: String, _id: false }],
    status: { type: String, enum: QUOTE_STATUSES, default: 'new', index: true },
    price: Number, // rupees, set by admin
    adminNote: String, // what the price includes, shown to the customer
    declineReason: String,
    quotedAt: Date,
    validUntil: Date,
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  },
  { timestamps: true },
)

export function toPublicQuote(doc) {
  const q = doc.toObject ? doc.toObject() : doc
  const expired = q.status === 'quoted' && q.validUntil && new Date(q.validUntil) < new Date()
  return {
    id: q._id.toString(),
    number: q.number,
    productId: q.productId || null,
    productName: q.productName || null,
    occasion: q.occasion || '',
    neededBy: q.neededBy || null,
    budget: q.budget || '',
    message: q.message || '',
    details: q.details,
    images: (q.images || []).map((i) => i.url),
    status: expired ? 'expired' : q.status,
    price: q.status === 'new' ? null : q.price ?? null,
    adminNote: q.adminNote || '',
    declineReason: q.declineReason || '',
    validUntil: q.validUntil || null,
    createdAt: q.createdAt,
  }
}

export default mongoose.model('Quote', quoteSchema)
