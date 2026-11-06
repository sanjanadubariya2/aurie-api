import mongoose from 'mongoose'

/**
 * A durable background job. Lives in Mongo so it survives restarts and needs
 * no Redis. Workers claim a job atomically (status pending -> running with a
 * lock), so running two API instances never processes one job twice.
 */
const jobSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['pending', 'running', 'done', 'failed'], default: 'pending' },
    runAt: { type: Date, default: () => new Date() },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    lockedUntil: Date,
    lastError: String,
    // Optional: at most one pending/running job per key (e.g. one reminder per cart).
    uniqueKey: String,
  },
  { timestamps: true },
)

jobSchema.index({ status: 1, runAt: 1 })
jobSchema.index(
  { uniqueKey: 1 },
  { unique: true, partialFilterExpression: { uniqueKey: { $type: 'string' }, status: { $in: ['pending', 'running'] } } },
)
// Finished jobs are kept for a week for debugging, then Mongo removes them.
jobSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 7 * 86_400, partialFilterExpression: { status: { $in: ['done', 'failed'] } } })

export default mongoose.model('Job', jobSchema)
