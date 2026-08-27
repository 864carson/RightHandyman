/**
 * In-memory data store.
 *
 * This exists so the base app runs and is testable with zero external
 * dependencies. Swap TenantRepository/UserRepository's internals for a real
 * database (Postgres, Mongo, etc.) later -- the rest of the app only talks
 * to the repository interfaces below, never to this store directly.
 */

function createStore() {
  return {
    tenants: new Map(), // id -> tenant
    tenantsBySlug: new Map(), // slug -> id
    users: new Map(), // id -> user
    // composite index: `${tenantId}:${provider}:${providerId}` -> userId
    usersByProviderIndex: new Map(),
    // composite index: `${tenantId}:${email}` -> userId
    usersByEmailIndex: new Map(),
    // tokenHash -> { tokenHash, tenantId, userId, createdAt, expiresAt, revoked }
    refreshTokens: new Map(),
    // jti -> { expiresAt } -- access tokens revoked before their natural expiry (logout)
    tokenBlocklist: new Map(),
    customers: new Map(), // id -> customer
    opportunities: new Map(), // id -> opportunity
    // `${tenantId}:${role}` -> string[] of permission keys, overriding the
    // built-in default for that role within this tenant
    rolePermissionOverrides: new Map()
  };
}

let store = createStore();

/** Resets all in-memory data. Intended for use in tests / dev reloads. */
function reset() {
  store = createStore();
}

function getStore() {
  return store;
}

module.exports = { getStore, reset };
