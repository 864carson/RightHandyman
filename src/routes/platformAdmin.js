const express = require('express');
const { timingSafeEqual } = require('crypto');
const { requireAuth } = require('../middleware/auth');
const requirePlatformAdmin = require('../middleware/requirePlatformAdmin');
const UserRepository = require('../models/User');
const TenantRepository = require('../models/Tenant');
const AuditLogRepository = require('../models/AuditLog');
const { signToken } = require('../utils/jwt');

const router = express.Router();

function secretsMatch(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  // timingSafeEqual throws on length mismatch rather than just returning
  // false -- pad instead of short-circuiting, so a wrong-length guess
  // doesn't return faster than a right-length one.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * POST /platform-admin/bootstrap-grant
 * Flips (or revokes) platformAdmin on an existing user, gated by a static
 * secret (PLATFORM_ADMIN_BOOTSTRAP_SECRET) rather than by an existing
 * platform admin -- there has to be *some* way to create the first one.
 * Treat this the way you'd treat a root/master key: set the env var only
 * long enough to grant your initial admin(s), then unset it (or restrict
 * it at the network/infra level) so this endpoint is effectively disabled
 * day to day. See README for the alternative once you're on a real,
 * persistent database (a one-off script against the DB directly).
 */
router.post('/bootstrap-grant', (req, res) => {
  const configuredSecret = process.env.PLATFORM_ADMIN_BOOTSTRAP_SECRET;
  if (!configuredSecret) {
    return res.status(503).json({ error: 'Bootstrap grant is disabled -- set PLATFORM_ADMIN_BOOTSTRAP_SECRET to enable it' });
  }
  if (!secretsMatch(req.headers['x-bootstrap-secret'], configuredSecret)) {
    return res.status(403).json({ error: 'Invalid bootstrap secret' });
  }

  const { tenantId, userId, grant } = req.body || {};
  if (!tenantId || !userId) {
    return res.status(400).json({ error: 'tenantId and userId are required' });
  }

  const updated = UserRepository.setPlatformAdmin(tenantId, userId, grant !== false);
  if (!updated) return res.status(404).json({ error: 'User not found in that tenant' });

  res.json(updated);
});

router.use(requireAuth);
router.use(requirePlatformAdmin);

/** GET /platform-admin/tenants -- every tenant that exists, so an admin knows what they can target. */
router.get('/tenants', (req, res) => {
  res.json(TenantRepository.list());
});

/**
 * POST /platform-admin/impersonate  { tenantId? | tenantSlug?, reason? }
 * Issues a short-lived, non-refreshable access token scoped to the target
 * tenant with `impersonation: { active: true, actingRole: 'owner',
 * homeTenantId }` embedded and signed into it. requirePermission/
 * requireRole recognize this and grant owner-level access in that tenant
 * without creating a real membership row there -- nothing shows up in the
 * target tenant's member list, and the moment the token expires (short by
 * design; see IMPERSONATION_TOKEN_EXPIRES_IN), access ends and re-requesting
 * it re-checks platformAdmin status from scratch. GET/customer/estimate
 * reads made with this token come back redacted by default -- pass
 * ?reveal=true to see real data, which is separately audit-logged.
 *
 * Every call here is recorded in the audit log (see AuditLog.js /
 * GET /tenants/:idOrSlug/impersonation-log), regardless of `reason` being
 * provided -- impersonation itself is never silent, even before anything
 * sensitive gets revealed.
 */
router.post('/impersonate', (req, res) => {
  const { tenantId, tenantSlug, reason } = req.body || {};
  if (!tenantId && !tenantSlug) {
    return res.status(400).json({ error: 'tenantId or tenantSlug is required' });
  }

  const targetTenant = tenantId ? TenantRepository.findById(tenantId) : TenantRepository.findBySlug(tenantSlug);
  if (!targetTenant) return res.status(404).json({ error: 'Tenant not found' });

  const actingRole = 'owner';
  const accessToken = signToken(
    {
      userId: req.user.userId,
      tenantId: targetTenant.id,
      impersonation: { active: true, actingRole, homeTenantId: req.user.tenantId }
    },
    { expiresIn: process.env.IMPERSONATION_TOKEN_EXPIRES_IN || '10m' }
  );

  AuditLogRepository.record({
    actorUserId: req.user.userId,
    actorHomeTenantId: req.user.tenantId,
    targetTenantId: targetTenant.id,
    action: 'impersonation_start',
    reason: reason || null
  });

  res.json({ accessToken, tokenType: 'Bearer', actingRole, tenant: targetTenant });
});

module.exports = router;
