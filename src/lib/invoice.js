import Order from '../models/Order.js'
import { nextSeq, financialYear } from '../models/Counter.js'

/**
 * Gives an order its GST invoice number the first time it becomes a real sale
 * (COD placed, or UPI paid). Numbers run consecutively per financial year:
 * AUR/26-27/00001, AUR/26-27/00002… Calling it again is a no-op.
 */
export async function assignInvoiceNumber(orderId) {
  const existing = await Order.findById(orderId, { invoiceNumber: 1 })
  if (!existing || existing.invoiceNumber) return existing?.invoiceNumber || null
  const fy = financialYear()
  const seq = await nextSeq(`invoice:${fy}`)
  const invoiceNumber = `AUR/${fy}/${String(seq).padStart(5, '0')}`
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, invoiceNumber: { $exists: false } },
    { $set: { invoiceNumber, invoicedAt: new Date() } },
    { new: true },
  )
  return updated?.invoiceNumber || null
}
