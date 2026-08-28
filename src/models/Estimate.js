const { randomUUID } = require('crypto');
const { getStore } = require('./db');
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
      // Unguessable token for the public, unauthenticated customer link --
      // same opaque-token approach this app already uses for refresh
      // tokens. Regenerated on every new version (see createRevision) so an
      // old link a customer may have bookmarked never silently starts
      // showing different numbers.
      shareToken: randomUUID(),
      sentAt: null,
      approvedAt: null,
      approvedBy: null,
      rejectedAt: null,
      rejectionReason: null,
      createdBy: createdBy || null,
      createdAt: now.toISOString()
    };

    store.estimates.set(id, estimate);
    store.estimatesByShareToken.set(estimate.shareToken, id);
    return estimate;
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
   * The token's randomness is the security boundary here, not tenant scoping.
   */
  findByShareToken(shareToken) {
    const store = getStore();
    const id = store.estimatesByShareToken.get(shareToken);
    return id ? store.estimates.get(id) : null;
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
      shareToken: randomUUID(),
      sentAt: null,
      approvedAt: null,
      approvedBy: null,
      rejectedAt: null,
      rejectionReason: null,
      createdBy: updates.createdBy || parent.createdBy,
      createdAt: now.toISOString(),
      updatedAt: undefined
    };
    delete revision.updatedAt;

    store.estimates.set(newId, revision);
    store.estimatesByShareToken.set(revision.shareToken, newId);

    parent.supersededBy = newId;
    if (parent.status !== 'approved') parent.status = 'superseded';
    parent.updatedAt = now.toISOString();

    return revision;
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
   * formal send step first. `approvedBy` is free-text name/signature, not a
   * User record -- the customer approving generally has no account here.
   */
  approve(tenantId, id, { approvedByName, signatureText } = {}) {
    const store = getStore();
    const estimate = store.estimates.get(id);
    if (!estimate || estimate.tenantId !== tenantId) return null;
    if (!['draft', 'sent'].includes(estimate.status)) {
      throw conflict(`Cannot approve an estimate with status "${estimate.status}"`);
    }

    const now = new Date();
    estimate.status = 'approved';
    estimate.approvedAt = now.toISOString();
    estimate.approvedBy = { name: approvedByName || null, signatureText: signatureText || null };
    estimate.updatedAt = now.toISOString();
    return estimate;
  }

  /** draft|sent -> rejected. */
  reject(tenantId, id, { reason } = {}) {
    const store = getStore();
    const estimate = store.estimates.get(id);
    if (!estimate || estimate.tenantId !== tenantId) return null;
    if (!['draft', 'sent'].includes(estimate.status)) {
      throw conflict(`Cannot reject an estimate with status "${estimate.status}"`);
    }

    const now = new Date();
    estimate.status = 'rejected';
    estimate.rejectedAt = now.toISOString();
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
    store.estimatesByShareToken.delete(estimate.shareToken);
    return true;
  }

  /** Removes every estimate for a job, regardless of status. Used when the job itself is deleted. */
  deleteAllForJob(tenantId, jobId) {
    const store = getStore();
    let count = 0;
    for (const estimate of this.listByJob(tenantId, jobId)) {
      store.estimates.delete(estimate.id);
      store.estimatesByShareToken.delete(estimate.shareToken);
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
      store.estimatesByShareToken.delete(estimate.shareToken);
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
