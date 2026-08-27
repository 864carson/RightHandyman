const TenantRepository = require('../models/Tenant');

/**
 * Resolves the tenant for a request and attaches it as req.tenant.
 *
 * Strategy is controlled by TENANT_RESOLUTION:
 *  - "header":    reads the `x-tenant-id` header (tenant slug or id) -- good default for APIs.
 *  - "subdomain": reads the leftmost subdomain, e.g. acme.yourapp.com -> "acme".
 *
 * Routes that don't require a tenant (e.g. tenant creation) should skip this
 * middleware entirely rather than relying on it being optional.
 */
function tenantResolver(options = {}) {
  const strategy = options.strategy || process.env.TENANT_RESOLUTION || 'header';

  return function resolve(req, res, next) {
    const slugOrId = strategy === 'subdomain' ? extractSubdomain(req) : extractHeader(req);

    if (!slugOrId) {
      return res.status(400).json({ error: 'Tenant could not be determined from the request' });
    }

    const tenant = TenantRepository.findBySlug(slugOrId) || TenantRepository.findById(slugOrId);

    if (!tenant) {
      return res.status(404).json({ error: `Unknown tenant: ${slugOrId}` });
    }

    req.tenant = tenant;
    next();
  };
}

function extractHeader(req) {
  const value = req.headers['x-tenant-id'];
  return Array.isArray(value) ? value[0] : value;
}

function extractSubdomain(req) {
  const host = req.hostname || '';
  const parts = host.split('.');
  // Need at least "tenant.domain.tld" to have a meaningful subdomain.
  if (parts.length < 3) return null;
  return parts[0];
}

module.exports = tenantResolver;
