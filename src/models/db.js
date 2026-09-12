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
    rolePermissionOverrides: new Map(),
    jobs: new Map(), // id -> job
    estimates: new Map(), // id -> estimate
    // sha256(shareToken) -> estimateId. Keyed by HASH, not the raw token --
    // only the hash is ever persisted (see models/Estimate.js /
    // utils/tokenHash.js), the same reasoning as hashing refreshTokens
    // above. Deliberately NOT tenant-scoped as a key -- the token's
    // randomness is the security boundary, looked up without knowing the
    // tenant in advance, e.g. from a public customer-facing link.
    estimatesByShareTokenHash: new Map(),
    catalogItems: new Map(), // id -> catalog item
    estimateTemplates: new Map(), // id -> estimate template
    // Append-only. reset() below still clears it (tests need a clean
    // slate) -- what's deliberate is that DELETE /tenants/:id does NOT
    // cascade-delete these, see models/AuditLog.js.
    auditLogEntries: new Map(),
    // Append-only legal acceptance/rejection ledger for estimates -- also
    // deliberately NOT cascade-deleted, see models/EstimateAcceptance.js.
    estimateAcceptances: new Map(),
    timeEntries: new Map() // id -> time entry
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
