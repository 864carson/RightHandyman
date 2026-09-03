const UserRepository = require('../models/User');

/**
 * Requires the authenticated user's HOME tenant record to have
 * platformAdmin: true. Unlike requirePermission/requireRole, this does NOT
 * depend on req.tenant/tenantResolver at all -- routes/platformAdmin.js is
 * deliberately mounted without tenant resolution, since its whole purpose
 * is reaching *other* tenants than whichever one the caller's own token
 * belongs to. The token's own `tenantId` (the caller's real home tenant,
 * from wherever they normally logged in) is used to look them up.
 *
 * Must run after requireAuth.
 */
function requirePlatformAdmin(req, res, next) {
  if (!req.user) {
    return res.status(500).json({ error: 'requirePlatformAdmin must run after requireAuth' });
  }

  const user = UserRepository.findById(req.user.tenantId, req.user.userId);
  if (!user) {
    return res.status(401).json({ error: 'User account no longer exists' });
  }
  if (!user.platformAdmin) {
    return res.status(403).json({ error: 'Platform admin access required' });
  }

  req.currentUser = user;
  next();
}

module.exports = requirePlatformAdmin;
