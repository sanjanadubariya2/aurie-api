import { isAllowedOrigin } from '../config.js'

/**
 * Defence in depth for cookie sessions: a state-changing request that names an
 * Origin must come from one of our own front ends. SameSite=Lax already blocks
 * most cross-site posts; this closes the rest. Requests without an Origin
 * (curl, server-to-server, the Razorpay webhook) are not cookie-borne attacks
 * and pass through to normal auth.
 */
export function originCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  const origin = req.headers.origin
  if (!origin || isAllowedOrigin(origin)) return next()
  req.log?.warn({ origin }, 'blocked request from an origin not in CORS_ORIGIN')
  return res.status(403).json({
    message: `Request blocked: ${origin} is not an allowed origin. Add it to CORS_ORIGIN in the API's environment.`,
  })
}
