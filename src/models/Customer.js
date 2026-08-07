import mongoose from 'mongoose'

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
    isDefault: Boolean,
  },
  { _id: false },
)

const customerSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: String,
    phone: String,
    phoneVerified: { type: Boolean, default: false },
    role: { type: String, enum: ['customer', 'admin'], default: 'customer' },
    passwordHash: String, // admins only — customers never get one
    addresses: [addressSchema],
  },
  { timestamps: true },
)

export default mongoose.model('Customer', customerSchema)
