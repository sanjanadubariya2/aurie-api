import bcrypt from 'bcryptjs'
import { connectDb, disconnectDb } from './db.js'
import Customer from './models/Customer.js'

// One-off script, not a public route — this panel can change prices and
// read every customer's address, so there is no self-service signup for it.
// Usage: npm run create-admin -- admin@example.com "a strong password"

async function main() {
  const [, , email, password] = process.argv
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
    { $set: { role: 'admin', passwordHash } },
    { upsert: true, new: true },
  )

  console.log(`Admin ready: ${admin.email}`)
  await disconnectDb()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
