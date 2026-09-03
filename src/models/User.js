const { randomUUID } = require('crypto');
const { getStore } = require('./db');

const VALID_ROLES = ['owner', 'admin', 'member'];
const VALID_STATUSES = ['active', 'invited'];

function providerKey(tenantId, provider, providerId) {
  return `${tenantId}:${provider}:${providerId}`;
}

function emailKey(tenantId, email) {
  return `${tenantId}:${email.trim().toLowerCase()}`;
}

class UserRepository {
  /**
   * Creates a user scoped to a tenant. The same email/provider identity can
   * exist independently in two different tenants -- that isolation is the
   * whole point of multi-tenancy.
   *
   * `provider`/`providerId` are optional so a tenant admin can invite
   * someone by email before they've ever logged in (status: 'invited').
   * Once they complete OAuth with a matching email, findOrCreateUser links
   * the provider identity and flips status to 'active'.
   */
  create({ tenantId, provider = null, providerId = null, email, displayName, avatarUrl, role, status }) {
    if (!tenantId || !email) {
      throw new Error('tenantId and email are required to create a user');
    }

    const store = getStore();
    const normalizedEmail = email.trim().toLowerCase();

    if (store.usersByEmailIndex.has(emailKey(tenantId, normalizedEmail))) {
      throw new Error(`A user with email "${normalizedEmail}" already exists in this tenant`);
    }

    const user = {
      id: randomUUID(),
      tenantId,
      provider,
      providerId,
      email: normalizedEmail,
      displayName: displayName || normalizedEmail,
      avatarUrl: avatarUrl || null,
      role: role && VALID_ROLES.includes(role) ? role : 'member',
      status: status && VALID_STATUSES.includes(status) ? status : 'active',
      // Cross-tenant platform support access (see requirePlatformAdmin /
      // routes/platformAdmin.js). Deliberately NOT settable via create()'s
      // caller-supplied fields or the generic update() method below --
      // the only way to flip this is setPlatformAdmin(), which nothing in
      // the normal signup/invite/self-service flow ever calls.
      platformAdmin: false,
      createdAt: new Date().toISOString()
    };

    store.users.set(user.id, user);
    if (provider && providerId) {
      store.usersByProviderIndex.set(providerKey(tenantId, provider, providerId), user.id);
    }
    store.usersByEmailIndex.set(emailKey(tenantId, normalizedEmail), user.id);

    return user;
  }

  findById(tenantId, id) {
    const store = getStore();
    const user = store.users.get(id);
    if (!user || user.tenantId !== tenantId) return null;
    return user;
  }

  findByProviderId(tenantId, provider, providerId) {
    const store = getStore();
    const id = store.usersByProviderIndex.get(providerKey(tenantId, provider, providerId));
    return id ? store.users.get(id) : null;
  }

  findByEmail(tenantId, email) {
    if (!email) return null;
    const store = getStore();
    const id = store.usersByEmailIndex.get(emailKey(tenantId, email));
    return id ? store.users.get(id) : null;
  }

  listByTenant(tenantId) {
    const store = getStore();
    return Array.from(store.users.values()).filter((u) => u.tenantId === tenantId);
  }

  countByTenant(tenantId) {
    return this.listByTenant(tenantId).length;
  }

  /**
   * Attaches a provider identity to an existing user record (linking a new
   * login method, or activating a pending invite on first real login).
   */
  linkProviderIdentity(tenantId, id, { provider, providerId, displayName, avatarUrl }) {
    const store = getStore();
    const user = store.users.get(id);
    if (!user || user.tenantId !== tenantId) return null;

    if (provider && providerId) {
      store.usersByProviderIndex.set(providerKey(tenantId, provider, providerId), user.id);
      user.provider = provider;
      user.providerId = providerId;
    }
    if (displayName && user.status === 'invited') user.displayName = displayName;
    if (avatarUrl) user.avatarUrl = avatarUrl;
    user.status = 'active';
    user.updatedAt = new Date().toISOString();

    return user;
  }

  /** Partial update. Only displayName, avatarUrl, role, status, and email are mutable. */
  update(tenantId, id, updates = {}) {
    const store = getStore();
    const user = store.users.get(id);
    if (!user || user.tenantId !== tenantId) return null;

    if (updates.role !== undefined && !VALID_ROLES.includes(updates.role)) {
      throw new Error(`role must be one of: ${VALID_ROLES.join(', ')}`);
    }
    if (updates.status !== undefined && !VALID_STATUSES.includes(updates.status)) {
      throw new Error(`status must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    if (updates.email !== undefined) {
      const normalizedEmail = updates.email.trim().toLowerCase();
      if (normalizedEmail !== user.email) {
        if (store.usersByEmailIndex.has(emailKey(tenantId, normalizedEmail))) {
          throw new Error(`A user with email "${normalizedEmail}" already exists in this tenant`);
        }
        store.usersByEmailIndex.delete(emailKey(tenantId, user.email));
        store.usersByEmailIndex.set(emailKey(tenantId, normalizedEmail), user.id);
        user.email = normalizedEmail;
      }
    }

    if (updates.displayName !== undefined) user.displayName = updates.displayName;
    if (updates.avatarUrl !== undefined) user.avatarUrl = updates.avatarUrl;
    if (updates.role !== undefined) user.role = updates.role;
    if (updates.status !== undefined) user.status = updates.status;

    user.updatedAt = new Date().toISOString();
    return user;
  }

  delete(tenantId, id) {
    const store = getStore();
    const user = store.users.get(id);
    if (!user || user.tenantId !== tenantId) return false;

    store.users.delete(id);
    store.usersByEmailIndex.delete(emailKey(tenantId, user.email));
    if (user.provider && user.providerId) {
      store.usersByProviderIndex.delete(providerKey(tenantId, user.provider, user.providerId));
    }
    return true;
  }

  /**
   * Grants or revokes platform-wide support access. Intentionally a
   * separate method from update() -- there is no request body field or API
   * route that maps to this, on purpose (see routes/platformAdmin.js for
   * the one narrow, secret-gated way this actually gets set).
   */
  setPlatformAdmin(tenantId, id, value) {
    const store = getStore();
    const user = store.users.get(id);
    if (!user || user.tenantId !== tenantId) return null;

    user.platformAdmin = Boolean(value);
    user.updatedAt = new Date().toISOString();
    return user;
  }

  /** Removes every user in a tenant. Used when a tenant itself is deleted. */
  deleteAllForTenant(tenantId) {
    let count = 0;
    for (const user of this.listByTenant(tenantId)) {
      this.delete(tenantId, user.id);
      count += 1;
    }
    return count;
  }
}

module.exports = new UserRepository();
module.exports.UserRepository = UserRepository;
module.exports.VALID_ROLES = VALID_ROLES;
module.exports.VALID_STATUSES = VALID_STATUSES;
