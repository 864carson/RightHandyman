const { getStore } = require('./db');
const { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } = require('../config/permissions');
const { VALID_ROLES } = require('./User');

function overrideKey(tenantId, role) {
  return `${tenantId}:${role}`;
}

class RolePermissionsRepository {
  /**
   * Returns the effective permission list for a role within a tenant: the
   * tenant's override if one has been set, otherwise the built-in default.
   */
  getEffectivePermissions(tenantId, role) {
    const store = getStore();
    const override = store.rolePermissionOverrides.get(overrideKey(tenantId, role));
    if (override) return [...override];
    return [...(DEFAULT_ROLE_PERMISSIONS[role] || [])];
  }

  /** Returns the effective permissions for every role in a tenant -- for an admin UI. */
  getEffectiveMatrix(tenantId) {
    const matrix = {};
    for (const role of VALID_ROLES) {
      matrix[role] = this.getEffectivePermissions(tenantId, role);
    }
    return matrix;
  }

  /** Replaces the permission set for one role within a tenant. */
  setOverride(tenantId, role, permissions) {
    if (!VALID_ROLES.includes(role)) {
      throw new Error(`role must be one of: ${VALID_ROLES.join(', ')}`);
    }
    if (!Array.isArray(permissions)) {
      throw new Error('permissions must be an array of permission strings');
    }
    const invalid = permissions.filter((p) => !ALL_PERMISSIONS.includes(p));
    if (invalid.length > 0) {
      throw new Error(`Unknown permission(s): ${invalid.join(', ')}`);
    }

    const store = getStore();
    const deduped = [...new Set(permissions)];
    store.rolePermissionOverrides.set(overrideKey(tenantId, role), deduped);
    return deduped;
  }

  /** Reverts a role to its built-in default permission set. Returns true if an override existed. */
  clearOverride(tenantId, role) {
    const store = getStore();
    return store.rolePermissionOverrides.delete(overrideKey(tenantId, role));
  }

  /** Clears every override for a tenant. Used when a tenant is deleted. */
  clearAllForTenant(tenantId) {
    for (const role of VALID_ROLES) {
      this.clearOverride(tenantId, role);
    }
  }
}

module.exports = new RolePermissionsRepository();
module.exports.RolePermissionsRepository = RolePermissionsRepository;
