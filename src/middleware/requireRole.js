const UserRepository = require('../models/User');

/**
 * Requires the authenticated user to hold one of the given roles within
 * req.tenant. Looks the user up fresh from the repository rather than
 * trusting the role embedded in the JWT, so a role change or removal takes
 * effect immediately rather than only after the token expires.
 *
 * Must run after tenantResolver/loadTenantParam (needs req.tenant) and
 * requireAuth (needs req.user).
 */
function requireRole(allowedRoles) {
  return function check(req, res, next) {
    if (!req.tenant || !req.user) {
      return res
        .status(500)
        .json({ error: 'requireRole must run after tenant resolution and requireAuth' });
    }

    const user = UserRepository.findById(req.tenant.id, req.user.userId);
    if (!user) {
      return res.status(401).json({ error: 'User account no longer exists' });
    }

    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions for this action' });
    }

    req.currentUser = user;
    next();
  };
}

module.exports = requireRole;
