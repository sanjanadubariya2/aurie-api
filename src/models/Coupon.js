import mongoose from 'mongoose'

/** Discount codes. Percent codes can carry a cap; usage is counted only when a
 *  sale is real (COD placed / UPI paid), so abandoned payments never burn one. */
const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: String, // shown to the customer, e.g. "10% off your first order"
    type: { type: String, enum: ['percent', 'flat'], required: true },
    value: { type: Number, required: true, min: 1 },
    maxDiscount: Number, // cap for percent codes, rupees
    minSubtotal: { type: Number, default: 0 },
    collection: String, // only items from this collection count (optional)
    firstOrderOnly: { type: Boolean, default: false },
    usageLimit: Number, // total uses across everyone (optional)
    perCustomerLimit: { type: Number, default: 1 },
    startsAt: Date,
    endsAt: Date,
    active: { type: Boolean, default: true },
    used: { type: Number, default: 0 },
  },
  { timestamps: true },
)

export default mongoose.model('Coupon', couponSchema)
