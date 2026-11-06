/** Anyone on the team (owner or staff). Mounted on the whole admin router. */
export function requireAdmin(req, res, next) {
  if (!['admin', 'staff'].includes(req.customer?.role)) {
    return res.status(403).json({ message: 'Not allowed' }) // 403, not 404 — do not hint the route exists
  }
  next()
}

/** Owner only: prices and products, refunds, exports, staff, materials. */
export function requireOwner(req, res, next) {
  if (req.customer?.role !== 'admin') {
    return res.status(403).json({ message: 'Only the shop owner can do that.' })
  }
  next()
}
