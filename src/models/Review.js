import mongoose from 'mongoose'

/** A verified-buyer review: only for products on the customer's delivered
 *  orders, one per product per order, shown once the owner approves it. */
const reviewSchema = new mongoose.Schema(
  {
    product: { type: String, required: true, index: true }, // slug
    productName: String,
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    authorName: String, // "Riya S." — first name + initial, never the email
    city: String,
    rating: { type: Number, min: 1, max: 5, required: true },
    text: { type: String, maxlength: 1000 },
    photo: { url: String, publicId: String },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  },
  { timestamps: true },
)
reviewSchema.index({ order: 1, product: 1 }, { unique: true })

export const toPublicReview = (r) => ({
  id: r._id.toString(),
  rating: r.rating,
  text: r.text || '',
  photo: r.photo?.url || null,
  author: r.authorName || 'A customer',
  city: r.city || '',
  createdAt: r.createdAt,
})

export default mongoose.model('Review', reviewSchema)
