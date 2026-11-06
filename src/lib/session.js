import { config } from '../config.js'
import { SESSION, signToken } from '../services/token.js'

/**
 * Sessions live in an httpOnly cookie — page JavaScript (and so any injected
 * script) cannot read it, unlike the localStorage token this replaces.
 * SameSite=Lax keeps cross-site form posts from carrying it. In production the
 * API must sit on the shop's own domain (api.aurie.website) so the cookie
 * counts as same-site for www.aurie.website and admin.aurie.website.
 */
const cookieOptions = (kind) => ({
  httpOnly: true,
  secure: config.isProd,
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION[kind].ttlSeconds * 1000,
})

/** Signs a token, sets it as the session cookie, and returns it (older clients still read it from the body). */
export function startSession(res, user, kind = 'customer') {
  const token = signToken(user, kind)
  res.cookie(SESSION[kind].cookie, token, cookieOptions(kind))
  return token
}

export function endSession(res, kind = 'customer') {
  const { maxAge, ...opts } = cookieOptions(kind)
  res.clearCookie(SESSION[kind].cookie, opts)
}
