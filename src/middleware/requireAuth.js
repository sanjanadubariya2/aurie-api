import Customer from '../models/Customer.js'
import { verifyToken } from '../services/token.js'

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.cookies?.token
  if (!token) return res.status(401).json({ message: 'Sign in to continue' })

  try {
    const payload = verifyToken(token)
    req.customer = await Customer.findById(payload.sub)
    if (!req.customer) return res.status(401).json({ message: 'Sign in to continue' })
    next()
  } catch {
    res.status(401).json({ message: 'Your session expired. Sign in again.' })
  }
}
