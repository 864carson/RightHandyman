const { randomUUID } = require('crypto');
const { getStore } = require('./db');

/**
 * An append-only record of every time a customer accepted or rejected an
 * estimate through the public share link -- the actual legal evidence
 * (UETA/E-SIGN Act: a typed name + explicit assent is sufficient for the
 * vast majority of B2B estimates) that they agreed to the price, captured
 * at the moment it happened.
 *
 * This is intentionally separate from Estimate.approvedBy/rejectedBy:
 * those fields on the estimate reflect its CURRENT state and get replaced
 * by a new version if the estimate is revised, but this ledger is never
 * overwritten or replaced -- every acceptance/rejection event, across
 * every version, stays here permanently. If a dispute ever comes down to
 * "did they actually agree to this", this table is the answer, not the
 * estimate row.
 *
 * No update() or delete() method exists on this repository, on purpose --
 * there is no legitimate reason to ever mutate an acceptance record after
 * the fact. Like AuditLog, this is deliberately NOT cascade-deleted when a
 * tenant or estimate is removed (see routes/tenant.js, models/Job.js) --
 * for the same reason AuditLog survives tenant deletion: a legal
 * acceptance record should outlive the account it was made under, not
 * disappear along with it.
 */
const ACTIONS = ['accepted', 'rejected'];

class EstimateAcceptanceRepository {
  record({ tenantId, estimateId, action, name, email, ipAddress, userAgent, tokenLast8, reason }) {
    if (!tenantId || !estimateId || !action || !name) {
      throw new Error('tenantId, estimateId, action, and name are required to record an acceptance event');
    }
    if (!ACTIONS.includes(action)) {
      throw new Error(`action must be one of: ${ACTIONS.join(', ')}`);
    }

    const store = getStore();
    const entry = {
      id: randomUUID(),
      tenantId,
      estimateId,
      action,
      name,
      email: email || null,
      // 'typed_name' is the only signature type this app collects today --
      // the field exists so a future drawn-signature or DocuSign-style
      // integration has somewhere to record that distinction without a
      // schema change.
      signatureType: 'typed_name',
      ipAddress: ipAddress || null,
      userAgent: userAgent || null,
      // Last 8 chars of the raw token used, NOT the full token and never
      // enough on its own to reconstruct or guess it -- purely so support
      // can answer "which link did they click" without the full share
      // token (which isn't even stored anywhere in plaintext, see
      // Estimate.js) needing to exist anywhere outside the moment it was
      // issued.
      tokenLast8: tokenLast8 || null,
      reason: reason || null,
      createdAt: new Date().toISOString()
    };

    store.estimateAcceptances.set(entry.id, entry);
    return entry;
  }

  /** Every acceptance/rejection event for one estimate, oldest first -- the full chronological legal record. */
  listForEstimate(tenantId, estimateId) {
    const store = getStore();
    return Array.from(store.estimateAcceptances.values())
      .filter((e) => e.tenantId === tenantId && e.estimateId === estimateId)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  /** The most recent event of a given action for an estimate, or null. Used for idempotent re-accept/re-reject. */
  findLatestForEstimate(tenantId, estimateId, action) {
    const events = this.listForEstimate(tenantId, estimateId).filter((e) => e.action === action);
    return events.length > 0 ? events[events.length - 1] : null;
  }
}

module.exports = new EstimateAcceptanceRepository();
module.exports.EstimateAcceptanceRepository = EstimateAcceptanceRepository;
module.exports.ACTIONS = ACTIONS;
