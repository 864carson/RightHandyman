const UserRepository = require('../models/User');

const VALID_ROLES = ['owner', 'admin', 'member'];

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Invites a person to a tenant by email before they've ever logged in.
 * Creates a placeholder user with status 'invited' and no provider
 * identity; the first time they complete OAuth with a matching email,
 * findOrCreateUser links that identity and activates the account.
 */
function inviteMember(tenantId, { email, role = 'member', displayName } = {}) {
  if (!email) {
    throw httpError('email is required', 400);
  }
  if (!VALID_ROLES.includes(role)) {
    throw httpError(`role must be one of: ${VALID_ROLES.join(', ')}`, 400);
  }

  const existing = UserRepository.findByEmail(tenantId, email);
  if (existing) {
    throw httpError('This email is already a member of the tenant', 409);
  }

  return UserRepository.create({
    tenantId,
    email,
    displayName: displayName || email,
    role,
    status: 'invited'
  });
}

/** Removes a member (or a still-pending invite) from a tenant. */
function removeMember(tenantId, userId) {
  const removed = UserRepository.delete(tenantId, userId);
  if (!removed) {
    throw httpError('Member not found', 404);
  }
  return true;
}

module.exports = { inviteMember, removeMember, VALID_ROLES };
