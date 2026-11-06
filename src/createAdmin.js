import bcrypt from 'bcryptjs'
import { connectDb, disconnectDb } from './db.js'
import Customer from './models/Customer.js'

// One-off script, not a public route — this panel can change prices and
// read every customer's address, so there is no self-service signup for it.
// Usage: npm run create-admin -- admin@example.com "a strong password" [admin|staff]
// (owners can also add staff from the admin panel's Team page)

async function main() {
  const [, , email, password, role = 'admin'] = process.argv
  if (!['admin', 'staff'].includes(role)) {
    console.error('Role must be admin or staff.')
    process.exit(1)
  }
  if (!email || !password) {
    console.error('Usage: npm run create-admin -- <email> <password>')
    process.exit(1)
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.')
    process.exit(1)
  }

  await connectDb()

  const passwordHash = await bcrypt.hash(password, 10)
  const admin = await Customer.findOneAndUpdate(
    { email: email.toLowerCase().trim() },
    { $set: { role, passwordHash }, $inc: { tokenVersion: 1 } },
    { upsert: true, new: true },
  )

  console.log(`${role === 'admin' ? 'Owner' : 'Staff'} account ready: ${admin.email}`)
  await disconnectDb()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
