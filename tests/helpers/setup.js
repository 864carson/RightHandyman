const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';

/** Resets in-memory data and seeds one tenant. Call in beforeEach(). */
function resetWithTenant(overrides = {}) {
  reset();
  return TenantRepository.create({
    name: overrides.name || 'Acme Inc',
    slug: overrides.slug || 'acme'
  });
}

module.exports = { resetWithTenant };
