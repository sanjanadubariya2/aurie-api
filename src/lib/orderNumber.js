import crypto from 'node:crypto'
import Order from '../models/Order.js'

/** AUR + 6 random digits. Not sequential — a sequential number tells
 *  competitors your order volume just by placing a test order. */
export async function generateOrderNumber() {
  for (let i = 0; i < 8; i++) {
    const candidate = `AUR${crypto.randomInt(100000, 1_000_000)}`
    // eslint-disable-next-line no-await-in-loop
    const exists = await Order.exists({ orderNumber: candidate })
    if (!exists) return candidate
  }
  throw new Error('Could not generate a unique order number')
}
