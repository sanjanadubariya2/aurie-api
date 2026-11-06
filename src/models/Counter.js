import mongoose from 'mongoose'

/** Atomic sequences — used for GST invoice numbers, which must be consecutive
 *  within a financial year (unlike order numbers, which are random on purpose). */
const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } })
const Counter = mongoose.model('Counter', counterSchema)

export async function nextSeq(name) {
  const doc = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, new: true })
  return doc.seq
}

/** Indian financial year label for a date: Apr 2026–Mar 2027 -> "26-27". */
export function financialYear(date = new Date()) {
  const ist = new Date(date.getTime() + 5.5 * 3_600_000)
  const y = ist.getUTCFullYear()
  const start = ist.getUTCMonth() >= 3 ? y : y - 1
  return `${String(start).slice(2)}-${String(start + 1).slice(2)}`
}

export default Counter
