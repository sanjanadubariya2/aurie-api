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
    // admin = owner (everything). staff = day-to-day fulfilment: orders, the
    // pour list and requests — but not prices, refunds, exports or staff.
    role: { type: String, enum: ['customer', 'admin', 'staff'], default: 'customer' },
    passwordHash: String, // admins only — customers never get one
    addresses: [addressSchema],
    // Bumped on "sign out everywhere" / password change — every token carrying
    // an older value stops working at once, without a token blacklist.
    tokenVersion: { type: Number, default: 0 },
    // Admin two-factor (TOTP). The secret is AES-GCM encrypted at rest.
    totpSecretEnc: String,
    totpEnabled: { type: Boolean, default: false },
  },
  { timestamps: true },
)

export default mongoose.model('Customer', customerSchema)
