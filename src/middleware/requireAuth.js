import Customer from '../models/Customer.js'
import { SESSION, verifyToken } from '../services/token.js'

/** Builds the auth middleware for one session kind ('customer' | 'admin'). */
export function authFor(kind) {
  return async function requireSession(req, res, next) {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.cookies?.[SESSION[kind].cookie]
    if (!token) return res.status(401).json({ message: 'Sign in to continue' })

    let payload
    try {
      payload = verifyToken(token, kind)
    } catch {
      return res.status(401).json({ message: 'Your session expired. Sign in again.' })
    }
    const customer = await Customer.findById(payload.sub).catch(() => null)
    // tokenVersion mismatch = signed out everywhere since this token was issued.
    if (!customer || (customer.tokenVersion || 0) !== (payload.v || 0)) {
      return res.status(401).json({ message: 'Your session expired. Sign in again.' })
    }
    req.customer = customer
    req.sessionKind = kind
    next()
  }
}

/** Storefront routes. */
export const requireAuth = authFor('customer')
/** Admin routes (pair with requireAdmin for the role check). */
export const requireAdminSession = authFor('admin')
