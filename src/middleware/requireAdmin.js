export function requireAdmin(req, res, next) {
  if (req.customer?.role !== 'admin') {
    return res.status(403).json({ message: 'Not allowed' }) // 403, not 404 — do not hint the route exists
  }
  next()
}
