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
 *
 * Impersonation: a platform-admin's impersonation token (see
 * routes/platformAdmin.js) carries `req.user.impersonation = { active:
 * true, actingRole, homeTenantId }` instead of a real membership row in
 * the target tenant. If no real user row exists for this tenant, but a
 * valid (signed, unexpired) impersonation session says otherwise, permissions
 * are resolved for `actingRole` exactly as they would be for a real user
 * with that role -- including that tenant's own permission overrides. Real
 * membership always takes priority: if the platform admin happens to also
 * be a genuine member of this tenant, their real role wins, not the
 * impersonation escape hatch.
 */
function requirePermission(permission) {
  return function check(req, res, next) {
    if (!req.tenant || !req.user) {
      return res
        .status(500)
        .json({ error: 'requirePermission must run after tenant resolution and requireAuth' });
    }

    const user = UserRepository.findById(req.tenant.id, req.user.userId);

    if (user) {
      const permissions = RolePermissions.getEffectivePermissions(req.tenant.id, user.role);
      if (!permissions.includes(permission)) {
        return res.status(403).json({ error: `Missing permission: ${permission}` });
      }
      req.currentUser = user;
      return next();
    }

    if (req.user.impersonation && req.user.impersonation.active) {
      const actingRole = req.user.impersonation.actingRole;
      const permissions = RolePermissions.getEffectivePermissions(req.tenant.id, actingRole);
      if (!permissions.includes(permission)) {
        return res.status(403).json({ error: `Missing permission: ${permission}` });
      }
      req.currentUser = { id: req.user.userId, tenantId: req.tenant.id, role: actingRole, impersonation: true };
      return next();
    }

    return res.status(401).json({ error: 'User account no longer exists' });
  };
}

module.exports = requirePermission;
