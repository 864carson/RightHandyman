/**
 * The permission system.
 *
 * Permissions are `resource:action` strings. Routes are gated by permission
 * (via middleware/requirePermission.js), not directly by role -- roles are
 * just a named bundle of permissions. This is what makes access
 * "feature-controllable": a tenant owner can override which permissions a
 * role grants (see models/RolePermissions.js) without any code change.
 *
 * A couple of operations (deleting a tenant outright, managing this very
 * permission matrix) are intentionally NOT part of this overridable system
 * -- they're checked via requireRole(['owner']) directly, so an owner can
 * never accidentally lock themselves out of their own tenant by editing the
 * matrix. Keep genuinely foundational/destructive actions off this list.
 */

const PERMISSIONS = Object.freeze({
  CUSTOMERS_CREATE: 'customers:create',
  CUSTOMERS_READ: 'customers:read',
  CUSTOMERS_UPDATE: 'customers:update',
  CUSTOMERS_DELETE: 'customers:delete',

  OPPORTUNITIES_CREATE: 'opportunities:create',
  OPPORTUNITIES_READ: 'opportunities:read',
  OPPORTUNITIES_UPDATE: 'opportunities:update',
  OPPORTUNITIES_DELETE: 'opportunities:delete',

  MEMBERS_INVITE: 'members:invite',
  MEMBERS_REMOVE: 'members:remove',

  TENANT_UPDATE: 'tenant:update'
});

const ALL_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));

/**
 * Built-in defaults, used whenever a tenant hasn't overridden a role.
 * `owner` gets everything overridable by default (a tenant can still choose
 * to narrow it down for itself via an override, but nothing forces that).
 */
const DEFAULT_ROLE_PERMISSIONS = Object.freeze({
  owner: [...ALL_PERMISSIONS],
  admin: [
    PERMISSIONS.CUSTOMERS_CREATE,
    PERMISSIONS.CUSTOMERS_READ,
    PERMISSIONS.CUSTOMERS_UPDATE,
    PERMISSIONS.CUSTOMERS_DELETE,
    PERMISSIONS.OPPORTUNITIES_CREATE,
    PERMISSIONS.OPPORTUNITIES_READ,
    PERMISSIONS.OPPORTUNITIES_UPDATE,
    PERMISSIONS.OPPORTUNITIES_DELETE,
    PERMISSIONS.MEMBERS_INVITE,
    PERMISSIONS.MEMBERS_REMOVE,
    PERMISSIONS.TENANT_UPDATE
  ],
  member: [
    PERMISSIONS.CUSTOMERS_CREATE,
    PERMISSIONS.CUSTOMERS_READ,
    PERMISSIONS.CUSTOMERS_UPDATE,
    PERMISSIONS.OPPORTUNITIES_CREATE,
    PERMISSIONS.OPPORTUNITIES_READ,
    PERMISSIONS.OPPORTUNITIES_UPDATE
  ]
});

module.exports = { PERMISSIONS, ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS };
