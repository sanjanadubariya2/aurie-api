import { connectDb, disconnectDb } from './db.js'
import Order from './models/Order.js'
import './models/Customer.js' // registers the model for populate()

// One-off: before `awaiting_payment` existed, a UPI order was saved as
// `placed` the moment the Razorpay popup opened — so customers who closed it
// still have an "Order placed" in their history and in the admin queue.
// This moves those unpaid UPI orders to `awaiting_payment`.
//
// Usage:  npm run fix-unpaid-upi            (dry run, changes nothing)
//         npm run fix-unpaid-upi -- --apply

const apply = process.argv.includes('--apply')

async function main() {
  await connectDb()
  const filter = { 'payment.method': 'upi', paymentStatus: { $ne: 'paid' }, status: 'placed' }
  const orders = await Order.find(filter).populate('customer', 'email').sort({ createdAt: 1 })
  console.log(`${orders.length} unpaid UPI order(s) still marked "placed":`)
  orders.forEach((o) =>
    console.log(`  ${o.orderNumber}  ${o.createdAt.toISOString().slice(0, 16)}  ₹${o.total}  ${o.customer?.email || '?'}  paymentStatus=${o.paymentStatus ?? '(none)'}`),
  )
  if (!apply) {
    console.log('\nDry run — nothing changed. Re-run with -- --apply to move them to awaiting_payment.')
  } else if (orders.length) {
    const res = await Order.updateMany(filter, {
      $set: { status: 'awaiting_payment', paymentStatus: 'pending' },
      $push: { statusHistory: { status: 'awaiting_payment', at: new Date(), by: 'fixUnpaidUpi' } },
    })
    console.log(`\nUpdated ${res.modifiedCount}.`)
  }
  await disconnectDb()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
