import mongoose from 'mongoose'

/** Raw materials — wax, wicks, jars, fragrance oils — with a low-stock line. */
const materialSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    unit: { type: String, default: 'pcs', trim: true }, // kg, pcs, ml…
    onHand: { type: Number, default: 0 },
    lowAt: { type: Number, default: 0 }, // alert when onHand <= lowAt
    supplier: { type: String, trim: true },
    notes: { type: String, trim: true },
  },
  { timestamps: true },
)

export default mongoose.model('Material', materialSchema)
