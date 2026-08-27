const TenantRepository = require('../models/Tenant');

/**
 * Resolves req.tenant from a route param (e.g. /tenants/:idOrSlug) rather
 * than the x-tenant-id header used by tenantResolver. Used on tenant-scoped
 * routes where the tenant is already part of the URL itself.
 */
function loadTenantParam(paramName = 'idOrSlug') {
  return function load(req, res, next) {
    const value = req.params[paramName];
    const tenant = TenantRepository.findById(value) || TenantRepository.findBySlug(value);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    req.tenant = tenant;
    next();
  };
}

module.exports = loadTenantParam;
