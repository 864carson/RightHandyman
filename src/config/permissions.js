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

  TENANT_UPDATE: 'tenant:update',

  JOBS_CREATE: 'jobs:create',
  JOBS_READ: 'jobs:read',
  JOBS_UPDATE: 'jobs:update',
  JOBS_DELETE: 'jobs:delete',

  ESTIMATES_CREATE: 'estimates:create',
  ESTIMATES_READ: 'estimates:read',
  ESTIMATES_UPDATE: 'estimates:update',
  ESTIMATES_DELETE: 'estimates:delete',
  // Recording that an estimate was sent, or the customer's approve/reject
  // decision, is kept separate from plain field edits (estimates:update) --
  // these are the actions with real business consequences (what the
  // customer actually agreed to), so a tenant can grant edit rights more
  // broadly than send/approve rights if it wants to.
  ESTIMATES_SEND: 'estimates:send',
  ESTIMATES_RECORD_RESPONSE: 'estimates:record-response',

  // Catalog items and estimate templates are managed together -- they're
  // both "the shared price book" from a permissions standpoint.
  CATALOG_READ: 'catalog:read',
  CATALOG_MANAGE: 'catalog:manage'
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
    PERMISSIONS.TENANT_UPDATE,
    PERMISSIONS.JOBS_CREATE,
    PERMISSIONS.JOBS_READ,
    PERMISSIONS.JOBS_UPDATE,
    PERMISSIONS.JOBS_DELETE,
    PERMISSIONS.ESTIMATES_CREATE,
    PERMISSIONS.ESTIMATES_READ,
    PERMISSIONS.ESTIMATES_UPDATE,
    PERMISSIONS.ESTIMATES_DELETE,
    PERMISSIONS.ESTIMATES_SEND,
    PERMISSIONS.ESTIMATES_RECORD_RESPONSE,
    PERMISSIONS.CATALOG_READ,
    PERMISSIONS.CATALOG_MANAGE
  ],
  member: [
    PERMISSIONS.CUSTOMERS_CREATE,
    PERMISSIONS.CUSTOMERS_READ,
    PERMISSIONS.CUSTOMERS_UPDATE,
    PERMISSIONS.OPPORTUNITIES_CREATE,
    PERMISSIONS.OPPORTUNITIES_READ,
    PERMISSIONS.OPPORTUNITIES_UPDATE,
    // Field estimators need full day-to-day estimating ability -- create,
    // tweak, send, and record what the customer said -- without needing
    // delete rights or catalog-management rights (that's an owner/admin
    // "protect the price book" concern, not a field concern).
    PERMISSIONS.JOBS_CREATE,
    PERMISSIONS.JOBS_READ,
    PERMISSIONS.JOBS_UPDATE,
    PERMISSIONS.ESTIMATES_CREATE,
    PERMISSIONS.ESTIMATES_READ,
    PERMISSIONS.ESTIMATES_UPDATE,
    PERMISSIONS.ESTIMATES_SEND,
    PERMISSIONS.ESTIMATES_RECORD_RESPONSE,
    PERMISSIONS.CATALOG_READ
  ]
});

module.exports = { PERMISSIONS, ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS };
