const UserRepository = require('../models/User');

/**
 * Requires the authenticated user to hold one of the given roles within
 * req.tenant. Looks the user up fresh from the repository rather than
 * trusting the role embedded in the JWT, so a role change or removal takes
 * effect immediately rather than only after the token expires.
 *
 * Must run after tenantResolver/loadTenantParam (needs req.tenant) and
 * requireAuth (needs req.user).
 *
 * Impersonation: see the matching note in requirePermission.js -- the same
 * fallback applies here so a platform admin's impersonation session can
 * satisfy role-gated routes (e.g. DELETE /tenants/:idOrSlug requires
 * 'owner'), using the acting role from their signed token when no real
 * membership row exists. Real membership still wins if both are true.
 */
function requireRole(allowedRoles) {
  return function check(req, res, next) {
    if (!req.tenant || !req.user) {
      return res
        .status(500)
        .json({ error: 'requireRole must run after tenant resolution and requireAuth' });
    }

    const user = UserRepository.findById(req.tenant.id, req.user.userId);

    if (user) {
      if (!allowedRoles.includes(user.role)) {
        return res.status(403).json({ error: 'Insufficient permissions for this action' });
      }
      req.currentUser = user;
      return next();
    }

    if (req.user.impersonation && req.user.impersonation.active) {
      const actingRole = req.user.impersonation.actingRole;
      if (!allowedRoles.includes(actingRole)) {
        return res.status(403).json({ error: 'Insufficient permissions for this action' });
      }
      req.currentUser = { id: req.user.userId, tenantId: req.tenant.id, role: actingRole, impersonation: true };
      return next();
    }

    return res.status(401).json({ error: 'User account no longer exists' });
  };
}

module.exports = requireRole;
