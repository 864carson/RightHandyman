const express = require('express');
const TenantRepository = require('../models/Tenant');
const UserRepository = require('../models/User');
const CustomerRepository = require('../models/Customer');
const OpportunityRepository = require('../models/Opportunity');
const RolePermissions = require('../models/RolePermissions');
const loadTenantParam = require('../middleware/loadTenantParam');
const { requireAuth } = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const requirePermission = require('../middleware/requirePermission');
const { PERMISSIONS, ALL_PERMISSIONS } = require('../config/permissions');
const { VALID_ROLES } = require('../models/User');
const { inviteMember, removeMember } = require('../controllers/membershipController');

const router = express.Router();

/**
 * POST /tenants  { name, slug }
 * Creates a new tenant. In a real app this would be gated behind an admin
 * role / signup flow -- left open here since this is a base template.
 */
router.post('/', (req, res) => {
  const { name, slug } = req.body || {};

  try {
    const tenant = TenantRepository.create({ name, slug });
    res.status(201).json(tenant);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:idOrSlug', (req, res) => {
  const { idOrSlug } = req.params;
  const tenant = TenantRepository.findById(idOrSlug) || TenantRepository.findBySlug(idOrSlug);

  if (!tenant) {
    return res.status(404).json({ error: 'Tenant not found' });
  }

  res.json(tenant);
});

/**
 * PATCH /tenants/:idOrSlug  { name?, slug? }
 * Requires the `tenant:update` permission -- overridable per tenant, unlike
 * tenant deletion below.
 */
router.patch('/:idOrSlug', loadTenantParam(), requireAuth, requirePermission(PERMISSIONS.TENANT_UPDATE), (req, res) => {
  const { name, slug } = req.body || {};

  try {
    const updated = TenantRepository.update(req.tenant.id, { name, slug });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /tenants/:idOrSlug
 * Deletes the tenant and everything in it (members, customers,
 * opportunities, permission overrides). Owner-only and NOT permission
 * overridable -- this is destructive and irreversible, and shouldn't be
 * something an owner can accidentally disable for themselves.
 */
router.delete('/:idOrSlug', loadTenantParam(), requireAuth, requireRole(['owner']), (req, res) => {
  OpportunityRepository.deleteAllForTenant(req.tenant.id);
  CustomerRepository.deleteAllForTenant(req.tenant.id);
  UserRepository.deleteAllForTenant(req.tenant.id);
  RolePermissions.clearAllForTenant(req.tenant.id);
  TenantRepository.remove(req.tenant.id);
  res.status(204).send();
});

/**
 * GET /tenants/:idOrSlug/members
 * Lists every member (active and pending-invite) of a tenant.
 */
router.get('/:idOrSlug/members', loadTenantParam(), requireAuth, (req, res) => {
  res.json(UserRepository.listByTenant(req.tenant.id));
});

/**
 * POST /tenants/:idOrSlug/members/invite  { email, role?, displayName? }
 * Creates a pending member (status: 'invited') by email, before they've
 * ever logged in. They're activated automatically on first OAuth login
 * with a matching email. Requires `members:invite`.
 */
router.post(
  '/:idOrSlug/members/invite',
  loadTenantParam(),
  requireAuth,
  requirePermission(PERMISSIONS.MEMBERS_INVITE),
  (req, res, next) => {
    try {
      const member = inviteMember(req.tenant.id, req.body || {});
      res.status(201).json(member);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /tenants/:idOrSlug/members/:userId
 * Removes a member (or a still-pending invite). Requires `members:remove`;
 * additionally, only an owner can remove another owner regardless of
 * permission overrides.
 */
router.delete(
  '/:idOrSlug/members/:userId',
  loadTenantParam(),
  requireAuth,
  requirePermission(PERMISSIONS.MEMBERS_REMOVE),
  (req, res, next) => {
    try {
      const target = UserRepository.findById(req.tenant.id, req.params.userId);
      if (target && target.role === 'owner' && req.currentUser.role !== 'owner') {
        throw Object.assign(new Error('Only an owner can remove another owner'), { status: 403 });
      }
      removeMember(req.tenant.id, req.params.userId);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /tenants/:idOrSlug/role-permissions/catalog
 * Lists every permission key and role name that exist, so a client can
 * build a permission-editing UI without hardcoding the list.
 */
router.get('/:idOrSlug/role-permissions/catalog', loadTenantParam(), requireAuth, (req, res) => {
  res.json({ permissions: ALL_PERMISSIONS, roles: VALID_ROLES });
});

/**
 * GET /tenants/:idOrSlug/role-permissions
 * Returns the tenant's effective permission matrix (defaults merged with
 * any overrides). Owner/admin only.
 */
router.get(
  '/:idOrSlug/role-permissions',
  loadTenantParam(),
  requireAuth,
  requireRole(['owner', 'admin']),
  (req, res) => {
    res.json(RolePermissions.getEffectiveMatrix(req.tenant.id));
  }
);

/**
 * PUT /tenants/:idOrSlug/role-permissions/:role  { permissions: string[] }
 * Replaces the permission set for one role in this tenant -- this IS the
 * "feature control via role assignment" knob. Owner-only and not itself
 * permission-overridable, so an owner can't accidentally lock everyone
 * (including themselves) out of managing permissions.
 */
router.put(
  '/:idOrSlug/role-permissions/:role',
  loadTenantParam(),
  requireAuth,
  requireRole(['owner']),
  (req, res, next) => {
    try {
      const { permissions } = req.body || {};
      const updated = RolePermissions.setOverride(req.tenant.id, req.params.role, permissions || []);
      res.json({ role: req.params.role, permissions: updated });
    } catch (err) {
      err.status = err.status || 400;
      next(err);
    }
  }
);

/**
 * DELETE /tenants/:idOrSlug/role-permissions/:role
 * Reverts a role to its built-in default permission set. Owner-only.
 */
router.delete(
  '/:idOrSlug/role-permissions/:role',
  loadTenantParam(),
  requireAuth,
  requireRole(['owner']),
  (req, res) => {
    RolePermissions.clearOverride(req.tenant.id, req.params.role);
    res.json({ role: req.params.role, permissions: RolePermissions.getEffectivePermissions(req.tenant.id, req.params.role) });
  }
);

module.exports = router;
