const express = require('express');
const tenantResolver = require('../middleware/tenantResolver');
const { requireAuth } = require('../middleware/auth');
const UserRepository = require('../models/User');
const RolePermissions = require('../models/RolePermissions');

const router = express.Router();

// Every route below requires both a resolvable tenant and a valid JWT
// scoped to that tenant.
router.use(tenantResolver());
router.use(requireAuth);

router.get('/me', (req, res) => {
  const user = UserRepository.findById(req.tenant.id, req.user.userId);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json(user);
});

/** Returns the current user's role and effective permissions in this tenant -- for building UI. */
router.get('/me/permissions', (req, res) => {
  const user = UserRepository.findById(req.tenant.id, req.user.userId);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({ role: user.role, permissions: RolePermissions.getEffectivePermissions(req.tenant.id, user.role) });
});

router.get('/', (req, res) => {
  res.json(UserRepository.listByTenant(req.tenant.id));
});

router.get('/:id', (req, res) => {
  const user = UserRepository.findById(req.tenant.id, req.params.id);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json(user);
});

/**
 * PATCH /users/:id
 * A user can always update their own displayName/avatarUrl. Changing role
 * or status -- or editing someone else's profile at all -- requires the
 * requester to be an owner or admin in this tenant.
 */
router.patch('/:id', (req, res) => {
  const { id } = req.params;
  const requester = UserRepository.findById(req.tenant.id, req.user.userId);

  if (!requester) {
    return res.status(401).json({ error: 'User account no longer exists' });
  }

  const isSelf = requester.id === id;
  const isElevated = requester.role === 'owner' || requester.role === 'admin';

  if (!isSelf && !isElevated) {
    return res.status(403).json({ error: 'You can only update your own profile' });
  }

  const { displayName, avatarUrl, role, status } = req.body || {};
  const updates = {};
  if (displayName !== undefined) updates.displayName = displayName;
  if (avatarUrl !== undefined) updates.avatarUrl = avatarUrl;

  if (role !== undefined || status !== undefined) {
    if (!isElevated) {
      return res.status(403).json({ error: 'Only owners/admins can change role or status' });
    }
    if (role !== undefined) updates.role = role;
    if (status !== undefined) updates.status = status;
  }

  try {
    const updated = UserRepository.update(req.tenant.id, id, updates);
    if (!updated) return res.status(404).json({ error: 'User not found' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /users/:id
 * A user can always delete their own account. Removing someone else
 * requires owner/admin, and only an owner can remove another owner.
 */
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const requester = UserRepository.findById(req.tenant.id, req.user.userId);

  if (!requester) {
    return res.status(401).json({ error: 'User account no longer exists' });
  }

  const target = UserRepository.findById(req.tenant.id, id);
  if (!target) {
    return res.status(404).json({ error: 'User not found' });
  }

  const isSelf = requester.id === id;
  const isElevated = requester.role === 'owner' || requester.role === 'admin';

  if (!isSelf && !isElevated) {
    return res.status(403).json({ error: 'You can only delete your own account' });
  }

  if (target.role === 'owner' && requester.role !== 'owner') {
    return res.status(403).json({ error: 'Only an owner can remove another owner' });
  }

  UserRepository.delete(req.tenant.id, id);
  res.status(204).send();
});

module.exports = router;
