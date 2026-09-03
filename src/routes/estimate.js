const express = require('express');
const tenantResolver = require('../middleware/tenantResolver');
const { requireAuth } = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { PERMISSIONS } = require('../config/permissions');
const EstimateRepository = require('../models/Estimate');
const estimateController = require('../controllers/estimateController');
const AuditLogRepository = require('../models/AuditLog');
const { redactEstimateFinancials } = require('../services/redaction');

const router = express.Router();

router.use(tenantResolver());
router.use(requireAuth);

/**
 * Redacts cost/markup/margin only during an impersonation session
 * (req.currentUser.impersonation, set by requirePermission's impersonation
 * fallback -- a tenant's own real members never hit this branch). Applied
 * everywhere an internal view leaves the process, not just GETs, so a
 * write-action response (send/approve/revise/...) can't leak margin data
 * that a GET on the same estimate would have redacted. `?reveal=true`
 * returns the real numbers and logs a `reveal_financials` audit entry.
 */
function presentEstimate(req, internalView) {
  if (!req.currentUser || !req.currentUser.impersonation) return internalView;

  const reveal = req.query.reveal === 'true';
  if (reveal) {
    AuditLogRepository.record({
      actorUserId: req.user.userId,
      actorHomeTenantId: req.user.impersonation.homeTenantId,
      targetTenantId: req.tenant.id,
      action: 'reveal_financials',
      resourceType: 'estimate',
      resourceId: internalView.id
    });
  }
  return redactEstimateFinancials(internalView, { reveal });
}

/** GET /estimates?jobId=<id> to scope to one job; omit to list every estimate version in the tenant. */
router.get('/', requirePermission(PERMISSIONS.ESTIMATES_READ), (req, res) => {
  const { jobId } = req.query;
  const estimates = jobId
    ? EstimateRepository.listByJob(req.tenant.id, jobId)
    : EstimateRepository.listByTenant(req.tenant.id);
  res.json(estimates.map((e) => presentEstimate(req, estimateController.buildInternalView(e))));
});

/**
 * GET /estimates/:id?view=customer
 * Defaults to the full internal view (cost, markup, margin). `?view=customer`
 * returns exactly what the public share link would show, so staff can
 * preview it before sending -- still requires estimates:read, this is not
 * the public endpoint (see routes/publicEstimate.js for that).
 */
router.get('/:id', requirePermission(PERMISSIONS.ESTIMATES_READ), (req, res) => {
  const estimate = EstimateRepository.findById(req.tenant.id, req.params.id);
  if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

  const view =
    req.query.view === 'customer'
      ? estimateController.buildCustomerView(estimate)
      : presentEstimate(req, estimateController.buildInternalView(estimate));
  res.json(view);
});

/** GET /estimates/:id/versions -- every version in this estimate's revision chain, oldest first. */
router.get('/:id/versions', requirePermission(PERMISSIONS.ESTIMATES_READ), (req, res) => {
  const estimate = EstimateRepository.findById(req.tenant.id, req.params.id);
  if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

  const versions = EstimateRepository.listVersions(req.tenant.id, estimate.rootEstimateId);
  res.json(versions.map((v) => presentEstimate(req, estimateController.buildInternalView(v))));
});

router.post('/', requirePermission(PERMISSIONS.ESTIMATES_CREATE), (req, res, next) => {
  const { jobId } = req.body || {};
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });

  try {
    const estimate = estimateController.createEstimate(req.tenant.id, { ...req.body, createdBy: req.user.userId });
    res.status(201).json(presentEstimate(req, estimateController.buildInternalView(estimate)));
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

/** POST /estimates/from-template  { jobId, templateId } */
router.post('/from-template', requirePermission(PERMISSIONS.ESTIMATES_CREATE), (req, res, next) => {
  const { jobId, templateId } = req.body || {};
  if (!jobId || !templateId) return res.status(400).json({ error: 'jobId and templateId are required' });

  try {
    const estimate = estimateController.createEstimateFromTemplate(req.tenant.id, {
      jobId,
      templateId,
      createdBy: req.user.userId
    });
    res.status(201).json(presentEstimate(req, estimateController.buildInternalView(estimate)));
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

/**
 * PATCH /estimates/:id
 * In-place edit -- only works while the estimate is still 'draft'. Once
 * sent/approved/rejected/expired, use POST /:id/revise instead so there's
 * always an honest record of what the customer actually saw.
 */
router.patch('/:id', requirePermission(PERMISSIONS.ESTIMATES_UPDATE), (req, res, next) => {
  try {
    const updated = EstimateRepository.update(req.tenant.id, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Estimate not found' });
    res.json(presentEstimate(req, estimateController.buildInternalView(updated)));
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

/**
 * POST /estimates/:id/revise  { asChangeOrder?, ...fields to change }
 * Creates a new version linked back to :id. Fields omitted from the body
 * are carried over from the version being revised. `asChangeOrder: true`
 * requires the version being revised to currently be 'approved' -- that's
 * the distinction between "still shopping the quote around" (plain revise)
 * and "customer already said yes, scope changed after the fact" (change
 * order), and both leave the original approved version's status untouched
 * for the record.
 */
router.post('/:id/revise', requirePermission(PERMISSIONS.ESTIMATES_UPDATE), (req, res, next) => {
  const { asChangeOrder, ...updates } = req.body || {};

  try {
    const revision = estimateController.reviseEstimate(req.tenant.id, req.params.id, updates, {
      asChangeOrder: Boolean(asChangeOrder),
      createdBy: req.user.userId
    });
    res.status(201).json(presentEstimate(req, estimateController.buildInternalView(revision)));
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

/** POST /estimates/:id/send -- draft -> sent. Staff-side "I sent this to the customer" action. */
router.post('/:id/send', requirePermission(PERMISSIONS.ESTIMATES_SEND), (req, res, next) => {
  try {
    const sent = EstimateRepository.markSent(req.tenant.id, req.params.id);
    if (!sent) return res.status(404).json({ error: 'Estimate not found' });
    res.json(presentEstimate(req, estimateController.buildInternalView(sent)));
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

/**
 * POST /estimates/:id/approve  { approvedByName?, signatureText? }
 * Staff-side recording of a customer's approval (e.g. verbal, or a signed
 * paper copy) -- for the customer approving themselves via the emailed
 * link, see POST /public/estimates/:shareToken/approve instead.
 */
router.post('/:id/approve', requirePermission(PERMISSIONS.ESTIMATES_RECORD_RESPONSE), (req, res, next) => {
  try {
    const approved = estimateController.recordApproval(req.tenant.id, req.params.id, req.body || {});
    if (!approved) return res.status(404).json({ error: 'Estimate not found' });
    res.json(presentEstimate(req, estimateController.buildInternalView(approved)));
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

/** POST /estimates/:id/reject  { reason? } */
router.post('/:id/reject', requirePermission(PERMISSIONS.ESTIMATES_RECORD_RESPONSE), (req, res, next) => {
  try {
    const rejected = estimateController.recordRejection(req.tenant.id, req.params.id, req.body || {});
    if (!rejected) return res.status(404).json({ error: 'Estimate not found' });
    res.json(presentEstimate(req, estimateController.buildInternalView(rejected)));
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

/** Only a never-sent draft can be deleted outright -- anything else is a business record (reject it instead). */
router.delete('/:id', requirePermission(PERMISSIONS.ESTIMATES_DELETE), (req, res, next) => {
  try {
    const removed = EstimateRepository.delete(req.tenant.id, req.params.id);
    if (!removed) return res.status(404).json({ error: 'Estimate not found' });
    res.status(204).send();
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

module.exports = router;
