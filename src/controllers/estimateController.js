const JobRepository = require('../models/Job');
const EstimateRepository = require('../models/Estimate');
const EstimateTemplateRepository = require('../models/EstimateTemplate');
const OpportunityRepository = require('../models/Opportunity');
const EstimateAcceptanceRepository = require('../models/EstimateAcceptance');
const { calculateEstimateTotals } = require('../services/estimateCalculations');
const { isPastValidity } = require('../models/Estimate');

function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}

/**
 * Full clickable link for a share token, only computable at the moment
 * the raw token is actually available (right after create/revise/
 * regenerate -- see models/Estimate.js) and only if PUBLIC_APP_URL is
 * configured. Returns null otherwise rather than guessing at a base URL.
 */
function buildShareUrl(estimate) {
  if (!estimate.shareToken || !process.env.PUBLIC_APP_URL) return null;
  return `${process.env.PUBLIC_APP_URL.replace(/\/+$/, '')}/public/estimates/${estimate.shareToken}`;
}

/**
 * Full internal view: every line item resolved with cost/markup/price/
 * margin, plus estimate-level totals and category rollups. This is what
 * the owner/estimator sees -- never send this shape to a customer.
 */
function buildInternalView(estimate) {
  const totals = calculateEstimateTotals(estimate);
  return {
    ...estimate,
    lineItems: totals.lineItems, // resolved: cost/markupAmount/price/marginPercent per line
    effectiveStatus: isPastValidity(estimate) ? 'expired' : estimate.status,
    // Only present right after create/revise/regenerate-link, when the raw
    // token is still attached to the object -- a normal GET-by-id never
    // has it (see models/Estimate.js), so this is naturally null on every
    // subsequent fetch, not just omitted.
    shareUrl: buildShareUrl(estimate),
    totals: {
      totalCost: totals.totalCost,
      totalMarkup: totals.totalMarkup,
      subtotalPrice: totals.subtotalPrice,
      taxRate: totals.taxRate,
      taxAmount: totals.taxAmount,
      totalPrice: totals.totalPrice,
      marginPercent: totals.marginPercent,
      depositType: totals.depositType,
      depositValue: totals.depositValue,
      deposit: totals.deposit,
      balanceDue: totals.balanceDue,
      byCategory: totals.byCategory
    }
  };
}

/**
 * Customer-facing view: cost, markup $, markup %, and margin are NEVER
 * included -- only quantity/unit/price per line, category price summary,
 * scope language, terms, and the bottom-line numbers a customer needs to
 * say yes. Per-line `notes` IS included (things like "client-supplied
 * paint" are scope clarifications the customer benefits from seeing); the
 * estimate-level `notes` field is treated as an internal scratch pad and
 * excluded.
 */
function buildCustomerView(estimate) {
  const totals = calculateEstimateTotals(estimate);
  return {
    id: estimate.id,
    jobId: estimate.jobId,
    version: estimate.version,
    isChangeOrder: estimate.isChangeOrder,
    status: estimate.status,
    effectiveStatus: isPastValidity(estimate) ? 'expired' : estimate.status,
    title: estimate.title,
    scopeIncluded: estimate.scopeIncluded,
    scopeExcluded: estimate.scopeExcluded,
    changeOrderNotice: estimate.changeOrderNotice,
    paymentTerms: estimate.paymentTerms,
    validUntil: estimate.validUntil,
    sentAt: estimate.sentAt,
    approvedAt: estimate.approvedAt,
    approvedBy: estimate.approvedBy,
    rejectedAt: estimate.rejectedAt,
    lineItems: totals.lineItems.map((li) => ({
      description: li.description,
      category: li.category,
      unit: li.unit,
      quantity: li.quantity,
      price: li.price,
      notes: li.notes
    })),
    categorySummary: Object.entries(totals.byCategory).map(([category, v]) => ({
      category,
      price: v.price
    })),
    taxRate: totals.taxRate,
    taxAmount: totals.taxAmount,
    totalPrice: totals.totalPrice,
    depositType: totals.depositType,
    depositValue: totals.depositValue,
    deposit: totals.deposit,
    balanceDue: totals.balanceDue
  };
}

/** Creates a job's first estimate and points the job at it. */
function createEstimate(tenantId, { jobId, ...fields }) {
  const job = JobRepository.findById(tenantId, jobId);
  if (!job) throw notFound('Job not found');

  const estimate = EstimateRepository.create({ ...fields, tenantId, jobId });
  JobRepository.setCurrentEstimate(tenantId, jobId, estimate.id);
  return estimate;
}

/**
 * Creates a draft estimate by copying a template's line items onto a job,
 * with the template's default quantities/costs ready to be tapped and
 * adjusted rather than typed from scratch.
 */
function createEstimateFromTemplate(tenantId, { jobId, templateId, createdBy }) {
  const job = JobRepository.findById(tenantId, jobId);
  if (!job) throw notFound('Job not found');

  const template = EstimateTemplateRepository.findById(tenantId, templateId);
  if (!template) throw notFound('Estimate template not found');

  const lineItems = template.lineItems.map((li) => ({
    description: li.description,
    category: li.category,
    catalogItemId: li.catalogItemId,
    unit: li.unit,
    quantity: li.defaultQuantity,
    unitCost: li.defaultUnitCost,
    markupType: li.markupType,
    markupValue: li.markupValue
  }));

  const estimate = EstimateRepository.create({ tenantId, jobId, title: template.name, lineItems, createdBy });
  JobRepository.setCurrentEstimate(tenantId, jobId, estimate.id);
  return estimate;
}

/**
 * Revises (or change-orders) an estimate and keeps the job's
 * currentEstimateId pointed at whatever's now the active version.
 */
function reviseEstimate(tenantId, id, updates, { asChangeOrder = false, createdBy } = {}) {
  const parent = EstimateRepository.findById(tenantId, id);
  if (!parent) throw notFound('Estimate not found');

  const revision = EstimateRepository.createRevision(tenantId, id, { ...updates, createdBy }, { asChangeOrder });
  JobRepository.setCurrentEstimate(tenantId, parent.jobId, revision.id);
  return revision;
}

/**
 * Records the customer's approval. If this is the job's first approval
 * (job still sitting in the default 'estimating' status), the job advances
 * to 'approved' automatically -- but this never overrides a status the
 * business has already moved further along (e.g. 'scheduled').
 */
function recordApproval(tenantId, id, payload) {
  const estimate = EstimateRepository.approve(tenantId, id, payload);
  if (!estimate) return null;

  const job = JobRepository.findById(tenantId, estimate.jobId);
  if (job && job.status === 'estimating') {
    JobRepository.update(tenantId, job.id, { status: 'approved' });
  }
  return estimate;
}

function recordRejection(tenantId, id, payload) {
  return EstimateRepository.reject(tenantId, id, payload);
}

/**
 * Records a customer's own accept/reject action from the public share
 * link. Always writes a permanent entry to the EstimateAcceptance ledger
 * (see models/EstimateAcceptance.js) in addition to updating the
 * estimate's own approvedBy/rejectedBy via recordApproval/recordRejection.
 *
 * Idempotent by design: if the SAME action is repeated on an estimate
 * that's already in that state (double-click, page refresh, a retried
 * network request), this returns the ORIGINAL acceptance event instead of
 * erroring or recording a duplicate one -- `idempotent: true` in the
 * result tells the caller nothing new happened. A genuinely conflicting
 * action (e.g. trying to accept something already rejected) still throws
 * the usual 409 from EstimateRepository.approve/reject, unchanged.
 */
function recordAcceptanceEvent(tenantId, id, { action, name, email, ipAddress, userAgent, tokenLast8, reason } = {}) {
  const estimate = EstimateRepository.findById(tenantId, id);
  if (!estimate) throw notFound('Estimate not found');

  const alreadyDoneStatus = action === 'accepted' ? 'approved' : 'rejected';
  if (estimate.status === alreadyDoneStatus) {
    const existing = EstimateAcceptanceRepository.findLatestForEstimate(tenantId, id, action);
    return { estimate, acceptance: existing, idempotent: true };
  }

  const updatedEstimate =
    action === 'accepted'
      ? recordApproval(tenantId, id, { approvedByName: name, approvedByEmail: email })
      : recordRejection(tenantId, id, { reason, rejectedByName: name, rejectedByEmail: email });

  const acceptance = EstimateAcceptanceRepository.record({
    tenantId,
    estimateId: id,
    action,
    name,
    email,
    ipAddress,
    userAgent,
    tokenLast8,
    reason
  });

  return { estimate: updatedEstimate, acceptance, idempotent: false };
}

/**
 * Converts a won (or about-to-be-won) Opportunity into a Job. Marks the
 * opportunity 'won' as part of the conversion if it wasn't already --
 * converting it IS the "we got the job" signal.
 */
function convertOpportunityToJob(tenantId, opportunityId, extra = {}, createdBy) {
  const opportunity = OpportunityRepository.findById(tenantId, opportunityId);
  if (!opportunity) throw notFound('Opportunity not found');

  if (opportunity.stage !== 'won') {
    OpportunityRepository.update(tenantId, opportunityId, { stage: 'won' });
  }

  return JobRepository.create({
    tenantId,
    customerId: opportunity.customerId,
    opportunityId: opportunity.id,
    title: extra.title || opportunity.name,
    description: extra.description,
    siteAddress: extra.siteAddress,
    weatherSensitive: extra.weatherSensitive,
    weatherNotes: extra.weatherNotes,
    notes: extra.notes,
    photos: extra.photos,
    createdBy
  });
}

module.exports = {
  buildInternalView,
  buildCustomerView,
  createEstimate,
  createEstimateFromTemplate,
  reviseEstimate,
  recordApproval,
  recordRejection,
  recordAcceptanceEvent,
  convertOpportunityToJob
};
