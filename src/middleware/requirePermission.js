const UserRepository = require('../models/User');
const RolePermissions = require('../models/RolePermissions');

/**
 * Requires the authenticated user's role to grant a specific permission
 * within req.tenant, per that tenant's effective permission matrix
 * (built-in default, unless the tenant has overridden the role -- see
 * models/RolePermissions.js). This is how "customer CRUD controlled by
 * role assignment" is implemented: the route just names a permission, and
 * which roles satisfy it is configurable per tenant, not hardcoded here.
 *
 * Looks the user up fresh (not from the JWT) so a role change or override
 * takes effect on the very next request. Must run after tenant resolution
 * and requireAuth.
 */
function requirePermission(permission) {
  return function check(req, res, next) {
    if (!req.tenant || !req.user) {
      return res
        .status(500)
        .json({ error: 'requirePermission must run after tenant resolution and requireAuth' });
    }

    const user = UserRepository.findById(req.tenant.id, req.user.userId);
    if (!user) {
      return res.status(401).json({ error: 'User account no longer exists' });
    }

    const permissions = RolePermissions.getEffectivePermissions(req.tenant.id, user.role);
    if (!permissions.includes(permission)) {
      return res.status(403).json({ error: `Missing permission: ${permission}` });
    }

    req.currentUser = user;
    next();
  };
}

module.exports = requirePermission;
