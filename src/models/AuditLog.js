const { randomUUID } = require('crypto');
const { getStore } = require('./db');

/**
 * An append-only record of every cross-tenant platform-support action:
 * starting an impersonation session, and every time redacted data (PII,
 * financials) is explicitly revealed during one. This exists so
 * "impersonate any tenant" is never a silent, untraceable capability --
 * a tenant's own owner can see exactly when and why platform staff looked
 * at their account (see GET /tenants/:idOrSlug/impersonation-log).
 *
 * Deliberately NOT cleaned up when a tenant is deleted (see
 * routes/tenant.js) -- an audit trail should outlive the thing it's
 * auditing, not disappear along with it.
 */
const ACTIONS = ['impersonation_start', 'reveal_pii', 'reveal_financials'];

class AuditLogRepository {
  record({ actorUserId, actorHomeTenantId, targetTenantId, action, resourceType, resourceId, reason }) {
    if (!actorUserId || !targetTenantId || !action) {
      throw new Error('actorUserId, targetTenantId, and action are required to record an audit log entry');
    }
    if (!ACTIONS.includes(action)) {
      throw new Error(`action must be one of: ${ACTIONS.join(', ')}`);
    }

    const store = getStore();
    const entry = {
      id: randomUUID(),
      actorUserId,
      actorHomeTenantId: actorHomeTenantId || null,
      targetTenantId,
      action,
      resourceType: resourceType || null,
      resourceId: resourceId || null,
      reason: reason || null,
      createdAt: new Date().toISOString()
    };

    store.auditLogEntries.set(entry.id, entry);
    return entry;
  }

  /** Every entry where this tenant was the one being accessed -- what a tenant owner sees. */
  listForTargetTenant(targetTenantId) {
    const store = getStore();
    return Array.from(store.auditLogEntries.values())
      .filter((e) => e.targetTenantId === targetTenantId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  /** Every entry a given platform admin has generated, across every tenant they've touched. */
  listByActor(actorUserId) {
    const store = getStore();
    return Array.from(store.auditLogEntries.values())
      .filter((e) => e.actorUserId === actorUserId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
}

module.exports = new AuditLogRepository();
module.exports.AuditLogRepository = AuditLogRepository;
module.exports.ACTIONS = ACTIONS;
