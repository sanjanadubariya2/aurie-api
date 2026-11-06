import mongoose from 'mongoose'

/** Who changed what in the admin panel. Read-only history — never edited. */
const auditSchema = new mongoose.Schema(
  {
    actor: { type: String, required: true }, // email of the admin/staff member, or "system"
    action: { type: String, required: true, index: true }, // e.g. order.status, product.update, refund.create
    target: { type: String, index: true }, // order number, product slug, quote number…
    details: mongoose.Schema.Types.Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)
auditSchema.index({ createdAt: -1 })
// Two years of history is plenty for a small shop.
auditSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2 * 365 * 86_400 })

export default mongoose.model('AuditLog', auditSchema)
