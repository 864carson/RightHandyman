const express = require('express');
const tenantResolver = require('../middleware/tenantResolver');
const { requireAuth } = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { PERMISSIONS } = require('../config/permissions');
const JobRepository = require('../models/Job');
const CustomerRepository = require('../models/Customer');
const OpportunityRepository = require('../models/Opportunity');
const EstimateRepository = require('../models/Estimate');
const AuditLogRepository = require('../models/AuditLog');
const { redactEstimateFinancials } = require('../services/redaction');
const { buildInternalView } = require('../controllers/estimateController');

const router = express.Router();

router.use(tenantResolver());
router.use(requireAuth);

/** GET /jobs?customerId=<id> to filter to one customer's job history. */
router.get('/', requirePermission(PERMISSIONS.JOBS_READ), (req, res) => {
  const { customerId } = req.query;
  const jobs = customerId
    ? JobRepository.listByCustomer(req.tenant.id, customerId)
    : JobRepository.listByTenant(req.tenant.id);
  res.json(jobs);
});

router.get('/:id', requirePermission(PERMISSIONS.JOBS_READ), (req, res) => {
  const job = JobRepository.findById(req.tenant.id, req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

/**
 * GET /jobs/:id/estimates
 * Every estimate version ever created for this job (all versions of every
 * revision chain), each with full internal cost/markup/margin detail, newest
 * first. This is the "pull up a customer's job history without ten separate
 * lookups" view -- everything about what was quoted lives under one job.
 */
router.get('/:id/estimates', requirePermission(PERMISSIONS.JOBS_READ), (req, res) => {
  const job = JobRepository.findById(req.tenant.id, req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const reveal = req.query.reveal === 'true';
  const estimates = EstimateRepository.listByJob(req.tenant.id, job.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(buildInternalView);

  if (!req.currentUser || !req.currentUser.impersonation) return res.json(estimates);

  if (reveal && estimates.length > 0) {
    AuditLogRepository.record({
      actorUserId: req.user.userId,
      actorHomeTenantId: req.user.impersonation.homeTenantId,
      targetTenantId: req.tenant.id,
      action: 'reveal_financials',
      resourceType: 'job',
      resourceId: job.id
    });
  }
  res.json(estimates.map((e) => redactEstimateFinancials(e, { reveal })));
});

router.post('/', requirePermission(PERMISSIONS.JOBS_CREATE), (req, res, next) => {
  const { customerId, opportunityId } = req.body || {};

  if (customerId && !CustomerRepository.findById(req.tenant.id, customerId)) {
    return res.status(400).json({ error: `Unknown customerId: ${customerId}` });
  }
  if (opportunityId && !OpportunityRepository.findById(req.tenant.id, opportunityId)) {
    return res.status(400).json({ error: `Unknown opportunityId: ${opportunityId}` });
  }

  try {
    // tenantId/createdBy come from the authenticated request, never the body.
    const job = JobRepository.create({ ...req.body, tenantId: req.tenant.id, createdBy: req.user.userId });
    res.status(201).json(job);
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

router.patch('/:id', requirePermission(PERMISSIONS.JOBS_UPDATE), (req, res, next) => {
  try {
    const updated = JobRepository.update(req.tenant.id, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Job not found' });
    res.json(updated);
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

/** Deletes a job and every estimate version ever created for it. */
router.delete('/:id', requirePermission(PERMISSIONS.JOBS_DELETE), (req, res) => {
  const removed = JobRepository.delete(req.tenant.id, req.params.id);
  if (!removed) return res.status(404).json({ error: 'Job not found' });
  EstimateRepository.deleteAllForJob(req.tenant.id, req.params.id);
  res.status(204).send();
});

module.exports = router;
