import jwt from 'jsonwebtoken'
import { config } from '../config.js'

/**
 * Two kinds of session, never interchangeable: `customer` (storefront, 30 days)
 * and `admin` (admin panel, 12 hours). The audience claim is checked on every
 * request, so a customer token is useless on admin routes even before the role
 * check. Payload stays thin — a JWT is signed, not encrypted.
 */
export const SESSION = {
  customer: { cookie: 'aurie_session', ttlSeconds: 30 * 86_400 },
  admin: { cookie: 'aurie_admin', ttlSeconds: 12 * 3_600 },
}

export const signToken = (customer, kind = 'customer') =>
  jwt.sign({ sub: customer._id.toString(), role: customer.role, v: customer.tokenVersion || 0 }, config.jwtSecret, {
    expiresIn: SESSION[kind].ttlSeconds,
    issuer: 'aurie',
    audience: kind,
  })

export const verifyToken = (token, kind = 'customer') => jwt.verify(token, config.jwtSecret, { issuer: 'aurie', audience: kind })
