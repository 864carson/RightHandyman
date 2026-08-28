const JobRepository = require('../models/Job');
const EstimateRepository = require('../models/Estimate');
const EstimateTemplateRepository = require('../models/EstimateTemplate');
const OpportunityRepository = require('../models/Opportunity');
const { calculateEstimateTotals } = require('../services/estimateCalculations');
const { isPastValidity } = require('../models/Estimate');

function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
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
  convertOpportunityToJob
};
