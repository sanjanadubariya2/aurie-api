import mongoose from 'mongoose'

const otpSchema = new mongoose.Schema(
  {
    identifier: { type: String, required: true, index: true }, // email or phone
    channel: { type: String, enum: ['email', 'sms'], required: true },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
)

// Mongo removes the document the moment expiresAt passes
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export default mongoose.model('Otp', otpSchema)
