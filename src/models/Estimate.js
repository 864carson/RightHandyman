const { randomUUID } = require('crypto');
const { getStore } = require('./db');
const { hashToken } = require('../utils/tokenHash');
const {
  LINE_ITEM_CATEGORIES,
  MARKUP_TYPES,
  DEPOSIT_TYPES,
  DEFAULT_VALID_DAYS,
  DEFAULT_MARKUP_PERCENT_BY_CATEGORY,
  DEFAULT_CHANGE_ORDER_NOTICE,
  DEFAULT_PAYMENT_TERMS
} = require('../config/estimateDefaults');

const ESTIMATE_STATUSES = ['draft', 'sent', 'approved', 'rejected', 'expired', 'superseded'];

function computeValidUntil(fromIso, validDays) {
  const days = typeof validDays === 'number' ? validDays : DEFAULT_VALID_DAYS;
  return new Date(new Date(fromIso).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Issues a fresh raw share token, stores only its hash + indexes the store
 * by that hash, and returns the raw value. The raw token is NEVER
 * persisted anywhere -- same reasoning as RefreshToken -- so it can only
 * ever be read back at the moment it's issued (create/revise/regenerate).
 * If it's lost, the fix is POST /estimates/:id/regenerate-link, not
 * recovering the old one.
 */
function issueShareToken(store, estimateId) {
  const raw = randomUUID();
  const hash = hashToken(raw);
  store.estimatesByShareTokenHash.set(hash, estimateId);
  return { raw, hash };
}

/** Validates and fills in defaults for one line item. Throws on bad input. */
function normalizeLineItem(li = {}) {
  if (!li.description || typeof li.description !== 'string') {
    throw new Error('each line item requires a description');
  }
  if (!li.unit || typeof li.unit !== 'string') {
    throw new Error('each line item requires a unit');
  }
  if (li.category !== undefined && !LINE_ITEM_CATEGORIES.includes(li.category)) {
    throw new Error(`line item category must be one of: ${LINE_ITEM_CATEGORIES.join(', ')}`);
  }
  if (li.markupType !== undefined && !MARKUP_TYPES.includes(li.markupType)) {
    throw new Error(`line item markupType must be one of: ${MARKUP_TYPES.join(', ')}`);
  }
  if (li.quantity !== undefined && typeof li.quantity !== 'number') {
    throw new Error('line item quantity must be a number');
  }
  if (li.unitCost !== undefined && typeof li.unitCost !== 'number') {
    throw new Error('line item unitCost must be a number');
  }
  if (li.markupValue !== undefined && typeof li.markupValue !== 'number') {
    throw new Error('line item markupValue must be a number');
  }

  const category = li.category || 'materials';
  return {
    id: li.id || randomUUID(),
    description: li.description,
    category,
    catalogItemId: li.catalogItemId || null,
    unit: li.unit,
    quantity: typeof li.quantity === 'number' ? li.quantity : 1,
    unitCost: typeof li.unitCost === 'number' ? li.unitCost : 0,
    markupType: li.markupType || 'percent',
    markupValue:
      typeof li.markupValue === 'number' ? li.markupValue : DEFAULT_MARKUP_PERCENT_BY_CATEGORY[category] ?? 0,
    notes: li.notes || null
  };
}

function normalizeLineItems(lineItems) {
  if (lineItems === undefined) return [];
  if (!Array.isArray(lineItems)) throw new Error('lineItems must be an array');
  return lineItems.map(normalizeLineItem);
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

class EstimateRepository {
  /** Creates version 1 of a new estimate, in 'draft' status. */
  create({
    tenantId,
    jobId,
    title,
    lineItems,
    scopeIncluded,
    scopeExcluded,
    changeOrderNotice,
    taxRate,
    depositType,
    depositValue,
    paymentTerms,
    notes,
    validDays,
    createdBy
  }) {
    if (!tenantId || !jobId) {
      throw new Error('tenantId and jobId are required to create an estimate');
    }
    if (depositType !== undefined && depositType !== null && !DEPOSIT_TYPES.includes(depositType)) {
      throw new Error(`depositType must be one of: ${DEPOSIT_TYPES.join(', ')}`);
    }
    if (taxRate !== undefined && typeof taxRate !== 'number') {
      throw new Error('taxRate must be a number');
    }

    const store = getStore();
    const id = randomUUID();
    const now = new Date();
    const resolvedValidDays = typeof validDays === 'number' ? validDays : DEFAULT_VALID_DAYS;
    const { raw: rawShareToken, hash: shareTokenHash } = issueShareToken(store, id);

    const estimate = {
      id,
      tenantId,
      jobId,
      version: 1,
      rootEstimateId: id,
      previousVersionId: null,
      supersededBy: null,
      isChangeOrder: false,
      status: 'draft',
      title: title || 'Estimate',
      lineItems: normalizeLineItems(lineItems),
      scopeIncluded: scopeIncluded || null,
      scopeExcluded: scopeExcluded || null,
      changeOrderNotice: changeOrderNotice || DEFAULT_CHANGE_ORDER_NOTICE,
      taxRate: typeof taxRate === 'number' ? taxRate : 0,
      depositType: depositType || null,
      depositValue: typeof depositValue === 'number' ? depositValue : null,
      paymentTerms: paymentTerms || DEFAULT_PAYMENT_TERMS,
      notes: notes || null,
      validDays: resolvedValidDays,
      validUntil: computeValidUntil(now.toISOString(), resolvedValidDays),
      // Only the HASH is persisted -- see issueShareToken() above and
      // utils/tokenHash.js. The raw token is attached to the object
      // returned below (this one call only); it is never stored and can't
      // be read back later via findById/findByShareToken.
      shareTokenHash,
      viewedAt: null,
      viewCount: 0,
      sentAt: null,
      approvedAt: null,
      approvedBy: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
      createdBy: createdBy || null,
      createdAt: now.toISOString()
    };

    store.estimates.set(id, estimate);
    return { ...estimate, shareToken: rawShareToken };
  }

  findById(tenantId, id) {
    const store = getStore();
    const estimate = store.estimates.get(id);
    if (!estimate || estimate.tenantId !== tenantId) return null;
    return estimate;
  }

  /**
   * Looks up an estimate by its public share token, with NO tenant check --
   * this is what the unauthenticated customer-facing link uses, where the
   * caller doesn't (and shouldn't need to) know which tenant it belongs to.
   * Hashes the raw token before lookup, since only the hash is persisted
   * (see issueShareToken above); the estimate object returned here never
   * has a `.shareToken` field, only `.shareTokenHash`.
   */
  findByShareToken(shareToken) {
    if (!shareToken) return null;
    const store = getStore();
    const id = store.estimatesByShareTokenHash.get(hashToken(shareToken));
    return id ? store.estimates.get(id) : null;
  }

  /**
   * Records that the public link was opened -- sets viewedAt on first view
   * only (never overwritten after), and increments viewCount every time.
   * Deliberately a separate explicit call rather than something findById
   * does automatically, so internal/staff lookups of the same estimate
   * never count as a "view" -- only the actual public link does.
   */
  recordView(tenantId, id) {
    const store = getStore();
    const estimate = store.estimates.get(id);
    if (!estimate || estimate.tenantId !== tenantId) return null;

    if (!estimate.viewedAt) estimate.viewedAt = new Date().toISOString();
    estimate.viewCount = (estimate.viewCount || 0) + 1;
    return estimate;
  }

  /**
   * Issues a brand new share token for an existing estimate and retires
   * the old one immediately (it stops resolving at all, rather than
   * quietly staying valid) -- the fix for "the customer lost the email",
   * without needing to revise the estimate's content just to get a new
   * link. Allowed in any status; regenerating a link never changes what
   * the estimate says or its approval state.
   */
  regenerateShareLink(tenantId, id) {
    const store = getStore();
    const estimate = store.estimates.get(id);
    if (!estimate || estimate.tenantId !== tenantId) return null;

    store.estimatesByShareTokenHash.delete(estimate.shareTokenHash);
    const { raw, hash } = issueShareToken(store, id);
    estimate.shareTokenHash = hash;
    estimate.updatedAt = new Date().toISOString();
    return { ...estimate, shareToken: raw };
  }

  listByJob(tenantId, jobId) {
    const store = getStore();
    return Array.from(store.estimates.values()).filter((e) => e.tenantId === tenantId && e.jobId === jobId);
  }

  listByTenant(tenantId) {
    const store = getStore();
    return Array.from(store.estimates.values()).filter((e) => e.tenantId === tenantId);
  }

  /** Every version in one estimate's chain, oldest first. */
  listVersions(tenantId, rootEstimateId) {
    return this.listByTenant(tenantId)
      .filter((e) => e.rootEstimateId === rootEstimateId)
      .sort((a, b) => a.version - b.version);
  }

  /**
   * In-place edit of a draft. Deliberately restricted to 'draft' status --
   * once an estimate has been sent, approving/rejecting/editing it further
   * needs to go through revise()/approve()/reject() so there's always an
   * honest record of what the customer actually saw and agreed to.
   */
  update(tenantId, id, updates = {}) {
    const store = getStore();
    const estimate = store.estimates.get(id);
    if (!estimate || estimate.tenantId !== tenantId) return null;
    if (estimate.status !== 'draft') {
      throw conflict(
        `Cannot edit an estimate with status "${estimate.status}" directly -- use reviseEstimate to create a new version`
      );
    }
    if (updates.depositType !== undefined && updates.depositType !== null && !DEPOSIT_TYPES.includes(updates.depositType)) {
      throw badRequest(`depositType must be one of: ${DEPOSIT_TYPES.join(', ')}`);
    }
    if (updates.taxRate !== undefined && typeof updates.taxRate !== 'number') {
      throw badRequest('taxRate must be a number');
    }

    if (updates.lineItems !== undefined) estimate.lineItems = normalizeLineItems(updates.lineItems);

    const allowed = [
      'title',
      'scopeIncluded',
      'scopeExcluded',
      'changeOrderNotice',
      'taxRate',
      'depositType',
      'depositValue',
      'paymentTerms',
      'notes',
      'validDays'
    ];
    for (const key of allowed) {
      if (updates[key] !== undefined) estimate[key] = updates[key];
    }
    if (updates.validDays !== undefined) {
      estimate.validUntil = computeValidUntil(estimate.createdAt, updates.validDays);
    }

    estimate.updatedAt = new Date().toISOString();
    return estimate;
  }

  /**
   * Creates a new version linked back to `id`. Everything not explicitly
   * passed in `updates` is carried over from the parent version, so a
   * caller can revise just one field (e.g. only lineItems) without having
   * to resend the whole estimate.
   *
   * If the parent was already 'approved', it KEEPS that status -- it's a
   * historical fact of what the customer actually signed off on -- rather
   * than being marked superseded. Anything else in flight gets marked
   * 'superseded'. Either way `supersededBy` points forward to the new
   * version so the chain is easy to walk in both directions.
   *
   * `asChangeOrder: true` additionally requires the parent to currently be
   * 'approved' -- that's the whole distinction between "just revise a quote
   * that hasn't gone out yet" and "the customer already said yes, now scope
   * changed and this needs to be tracked as a change order".
   */
  createRevision(tenantId, id, updates = {}, { asChangeOrder = false } = {}) {
    const store = getStore();
    const parent = store.estimates.get(id);
    if (!parent || parent.tenantId !== tenantId) return null;

    if (parent.supersededBy) {
      throw conflict(`This version has already been superseded -- revise version ${parent.supersededBy} instead`);
    }
    if (asChangeOrder && parent.status !== 'approved') {
      throw conflict('A change order can only be added to an approved estimate -- use a regular revision instead');
    }

    const newId = randomUUID();
    const now = new Date();
    const resolvedValidDays = updates.validDays !== undefined ? updates.validDays : parent.validDays;
    const { raw: rawShareToken, hash: shareTokenHash } = issueShareToken(store, newId);

    const revision = {
      ...parent,
      id: newId,
      version: parent.version + 1,
      previousVersionId: parent.id,
      rootEstimateId: parent.rootEstimateId,
      supersededBy: null,
      isChangeOrder: Boolean(asChangeOrder),
      status: 'draft',
      lineItems: updates.lineItems !== undefined ? normalizeLineItems(updates.lineItems) : parent.lineItems.map((li) => ({ ...li })),
      title: updates.title !== undefined ? updates.title : parent.title,
      scopeIncluded: updates.scopeIncluded !== undefined ? updates.scopeIncluded : parent.scopeIncluded,
      scopeExcluded: updates.scopeExcluded !== undefined ? updates.scopeExcluded : parent.scopeExcluded,
      changeOrderNotice: updates.changeOrderNotice !== undefined ? updates.changeOrderNotice : parent.changeOrderNotice,
      taxRate: updates.taxRate !== undefined ? updates.taxRate : parent.taxRate,
      depositType: updates.depositType !== undefined ? updates.depositType : parent.depositType,
      depositValue: updates.depositValue !== undefined ? updates.depositValue : parent.depositValue,
      paymentTerms: updates.paymentTerms !== undefined ? updates.paymentTerms : parent.paymentTerms,
      notes: updates.notes !== undefined ? updates.notes : parent.notes,
      validDays: resolvedValidDays,
      validUntil: computeValidUntil(now.toISOString(), resolvedValidDays),
      shareTokenHash,
      viewedAt: null,
      viewCount: 0,
      sentAt: null,
      approvedAt: null,
      approvedBy: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
      createdBy: updates.createdBy || parent.createdBy,
      createdAt: now.toISOString(),
      updatedAt: undefined
    };
    delete revision.updatedAt;

    store.estimates.set(newId, revision);

    parent.supersededBy = newId;
    if (parent.status !== 'approved') parent.status = 'superseded';
    parent.updatedAt = now.toISOString();

    return { ...revision, shareToken: rawShareToken };
  }

  /** draft -> sent. Re-baselines the validity window from the moment it's actually sent. */
  markSent(tenantId, id) {
    const store = getStore();
    const estimate = store.estimates.get(id);
    if (!estimate || estimate.tenantId !== tenantId) return null;
    if (estimate.status !== 'draft') {
      throw conflict(`Cannot send an estimate with status "${estimate.status}" -- only a draft can be sent`);
    }

    const now = new Date();
    estimate.status = 'sent';
    estimate.sentAt = now.toISOString();
    estimate.validUntil = computeValidUntil(estimate.sentAt, estimate.validDays);
    estimate.updatedAt = now.toISOString();
    return estimate;
  }

  /**
   * draft|sent -> approved. Allowed from 'draft' too (not just 'sent') to
   * cover verbal/in-person approval that staff record on the spot without a
   * formal send step first. `approvedBy` is free-text name/email/signature,
   * not a User record -- the customer approving generally has no account
   * here. For the full legal audit trail of a customer's own acceptance
   * (IP, user agent, exact token used), see models/EstimateAcceptance.js --
   * this field only reflects the estimate's current state, and gets
   * replaced if the estimate is later revised.
   */
  approve(tenantId, id, { approvedByName, approvedByEmail, signatureText } = {}) {
    const store = getStore();
    const estimate = store.estimates.get(id);
    if (!estimate || estimate.tenantId !== tenantId) return null;
    if (!['draft', 'sent'].includes(estimate.status)) {
      throw conflict(`Cannot approve an estimate with status "${estimate.status}"`);
    }

    const now = new Date();
    estimate.status = 'approved';
    estimate.approvedAt = now.toISOString();
    estimate.approvedBy = { name: approvedByName || null, email: approvedByEmail || null, signatureText: signatureText || null };
    estimate.updatedAt = now.toISOString();
    return estimate;
  }

  /** draft|sent -> rejected. */
  reject(tenantId, id, { reason, rejectedByName, rejectedByEmail } = {}) {
    const store = getStore();
    const estimate = store.estimates.get(id);
    if (!estimate || estimate.tenantId !== tenantId) return null;
    if (!['draft', 'sent'].includes(estimate.status)) {
      throw conflict(`Cannot reject an estimate with status "${estimate.status}"`);
    }

    const now = new Date();
    estimate.status = 'rejected';
    estimate.rejectedAt = now.toISOString();
    estimate.rejectedBy = { name: rejectedByName || null, email: rejectedByEmail || null };
    estimate.rejectionReason = reason || null;
    estimate.updatedAt = now.toISOString();
    return estimate;
  }

  /** draft|sent -> expired. An explicit staff action; nothing flips this automatically (see isPastValidity for display-only detection). */
  expire(tenantId, id) {
    const store = getStore();
    const estimate = store.estimates.get(id);
    if (!estimate || estimate.tenantId !== tenantId) return null;
    if (!['draft', 'sent'].includes(estimate.status)) {
      throw conflict(`Cannot expire an estimate with status "${estimate.status}"`);
    }

    estimate.status = 'expired';
    estimate.updatedAt = new Date().toISOString();
    return estimate;
  }

  /** Only a never-sent draft can be deleted outright -- anything else is a business record. */
  delete(tenantId, id) {
    const store = getStore();
    const estimate = store.estimates.get(id);
    if (!estimate || estimate.tenantId !== tenantId) return false;
    if (estimate.status !== 'draft') {
      throw conflict(`Cannot delete an estimate with status "${estimate.status}" -- only a draft can be deleted`);
    }

    store.estimates.delete(id);
    store.estimatesByShareTokenHash.delete(estimate.shareTokenHash);
    return true;
  }

  /** Removes every estimate for a job, regardless of status. Used when the job itself is deleted. */
  deleteAllForJob(tenantId, jobId) {
    const store = getStore();
    let count = 0;
    for (const estimate of this.listByJob(tenantId, jobId)) {
      store.estimates.delete(estimate.id);
      store.estimatesByShareTokenHash.delete(estimate.shareTokenHash);
      count += 1;
    }
    return count;
  }

  /** Removes every estimate in a tenant. Used when a tenant itself is deleted. */
  deleteAllForTenant(tenantId) {
    const store = getStore();
    let count = 0;
    for (const estimate of this.listByTenant(tenantId)) {
      store.estimates.delete(estimate.id);
      store.estimatesByShareTokenHash.delete(estimate.shareTokenHash);
      count += 1;
    }
    return count;
  }
}

/**
 * Display-only check: true if a draft/sent estimate is past its validUntil
 * date. Deliberately does NOT mutate stored status (a GET should never have
 * side effects) -- callers show this alongside the real status, and a
 * staff member can call expire() explicitly if they want it to stick.
 */
function isPastValidity(estimate, now = new Date()) {
  if (!['draft', 'sent'].includes(estimate.status)) return false;
  if (!estimate.validUntil) return false;
  return new Date(estimate.validUntil).getTime() < now.getTime();
}

module.exports = new EstimateRepository();
module.exports.EstimateRepository = EstimateRepository;
module.exports.ESTIMATE_STATUSES = ESTIMATE_STATUSES;
module.exports.isPastValidity = isPastValidity;
module.exports.normalizeLineItems = normalizeLineItems;
