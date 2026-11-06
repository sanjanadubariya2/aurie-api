import AuditLog from '../models/AuditLog.js'
import { logger } from './logger.js'

/** Records an admin action. Never throws — losing an audit line must not fail the action itself. */
export async function audit(actor, action, target, details) {
  try {
    await AuditLog.create({ actor: actor || 'system', action, target: target ? String(target) : undefined, details })
  } catch (err) {
    logger.error({ err: err.message, action, target }, 'audit write failed')
  }
}

/** Convenience for route handlers: the signed-in admin/staff member is the actor. */
export const auditReq = (req, action, target, details) => audit(req.customer?.email, action, target, details)
