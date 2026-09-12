const express = require('express');
const tenantResolver = require('../middleware/tenantResolver');
const { requireAuth } = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { PERMISSIONS } = require('../config/permissions');
const JobRepository = require('../models/Job');
const CustomerRepository = require('../models/Customer');
const OpportunityRepository = require('../models/Opportunity');
const EstimateRepository = require('../models/Estimate');
const TimeEntryRepository = require('../models/TimeEntry');
const AuditLogRepository = require('../models/AuditLog');
const { redactEstimateFinancials, redactTimeEntryFinancials, redactTimeSummaryFinancials } = require('../services/redaction');
const { buildInternalView } = require('../controllers/estimateController');
const timeTrackingController = require('../controllers/timeTrackingController');

const router = express.Router();

router.use(tenantResolver());
router.use(requireAuth);

/**
 * Redacts payroll-adjacent cost figures only during an impersonation
 * session (req.currentUser.impersonation, set by requirePermission's
 * impersonation fallback -- a tenant's own real members never hit this
 * branch). `?reveal=true` returns the real numbers and logs a
 * `reveal_financials` audit entry, same pattern as estimates/customers.
 */
function presentTimeData(req, resourceType, resourceId, data, redactFn) {
  if (!req.currentUser || !req.currentUser.impersonation) return data;

  const reveal = req.query.reveal === 'true';
  if (reveal) {
    AuditLogRepository.record({
      actorUserId: req.user.userId,
      actorHomeTenantId: req.user.impersonation.homeTenantId,
      targetTenantId: req.tenant.id,
      action: 'reveal_financials',
      resourceType,
      resourceId
    });
  }
  return redactFn(data, { reveal });
}

/**
 * Redacts a job's finalPriceSnapshot (which carries the same cost-side
 * figures as a time summary) using the same presentTimeData mechanics --
 * a job object is returned from several routes below, and every one of
 * them needs this, not just the finalize-pricing response, or the
 * snapshot would leak cost data unredacted right alongside a "redacted"
 * summary sitting next to it in the same payload. Honors `?reveal=true`
 * and logs it the same as any other reveal.
 */
function presentJob(req, job) {
  if (!job || !job.finalPriceSnapshot) return job;
  if (!req.currentUser || !req.currentUser.impersonation) return job;

  return {
    ...job,
    finalPriceSnapshot: presentTimeData(req, 'job', job.id, job.finalPriceSnapshot, redactTimeSummaryFinancials)
  };
}

/** GET /jobs?customerId=<id> to filter to one customer's job history. */
router.get('/', requirePermission(PERMISSIONS.JOBS_READ), (req, res) => {
  const { customerId } = req.query;
  const jobs = customerId
    ? JobRepository.listByCustomer(req.tenant.id, customerId)
    : JobRepository.listByTenant(req.tenant.id);
  res.json(jobs.map((j) => presentJob(req, j)));
});

router.get('/:id', requirePermission(PERMISSIONS.JOBS_READ), (req, res) => {
  const job = JobRepository.findById(req.tenant.id, req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(presentJob(req, job));
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

/**
 * GET /jobs/:id/time-entries
 * Every time entry (active or completed) logged against this job, newest
 * first. Full detail including cost/billing rate for staff -- redacted
 * during platform-admin impersonation, same as estimate financials.
 */
router.get('/:id/time-entries', requirePermission(PERMISSIONS.TIME_ENTRIES_READ), (req, res) => {
  const job = JobRepository.findById(req.tenant.id, req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const entries = TimeEntryRepository.listByJob(req.tenant.id, job.id).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  const presented = entries.map((e) => presentTimeData(req, 'time-entry', e.id, e, redactTimeEntryFinancials));
  res.json(presented);
});

/**
 * GET /jobs/:id/time-summary
 * Quoted-vs-actual labor comparison (fixed-price jobs) or the trued-up
 * final price (time_and_materials jobs) -- see
 * services/timeTrackingCalculations.js. Recomputed fresh on every read,
 * same "never trust a stored total" philosophy as estimate totals.
 */
router.get('/:id/time-summary', requirePermission(PERMISSIONS.TIME_ENTRIES_READ), (req, res, next) => {
  try {
    const summary = timeTrackingController.getJobPricingSummary(req.tenant.id, req.params.id);
    res.json(presentTimeData(req, 'job', req.params.id, summary, redactTimeSummaryFinancials));
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

/**
 * POST /jobs/:id/time-entries  { userId, clockIn, clockOut, notes?, billable?, hourlyCost?, billingRate? }
 * Manager-entered time on behalf of a specific employee -- a paper
 * timesheet, correcting a forgotten clock-out, etc. For self clock-in/out,
 * see POST /time-entries/clock-in (routes/timeEntry.js). Rate overrides
 * win; otherwise the employee's own stored default rates are used.
 */
router.post('/:id/time-entries', requirePermission(PERMISSIONS.TIME_ENTRIES_MANAGE), (req, res, next) => {
  try {
    const entry = timeTrackingController.createManualEntry(req.tenant.id, req.params.id, {
      ...req.body,
      createdBy: req.user.userId
    });
    res.status(201).json(presentTimeData(req, 'time-entry', entry.id, entry, redactTimeEntryFinancials));
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

/**
 * POST /jobs/:id/finalize-pricing
 * Locks in the final numbers -- refuses if anyone's still clocked in on
 * this job. Computes and snapshots the pricing summary onto the job, and
 * locks every time entry for it so none can be edited/deleted afterward.
 */
router.post('/:id/finalize-pricing', requirePermission(PERMISSIONS.TIME_ENTRIES_MANAGE), (req, res, next) => {
  try {
    const { job } = timeTrackingController.finalizeJobPricing(req.tenant.id, req.params.id);
    // job.finalPriceSnapshot IS the computed summary -- presentJob already
    // redacts/reveals+audit-logs it, no need for a second, duplicate field.
    res.json(presentJob(req, job));
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
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
    res.status(201).json(job); // a freshly created job never has a finalPriceSnapshot yet -- nothing to redact
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

router.patch('/:id', requirePermission(PERMISSIONS.JOBS_UPDATE), (req, res, next) => {
  try {
    const updated = JobRepository.update(req.tenant.id, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Job not found' });
    res.json(presentJob(req, updated));
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

/** Deletes a job and every estimate version + time entry ever created for it. */
router.delete('/:id', requirePermission(PERMISSIONS.JOBS_DELETE), (req, res) => {
  const removed = JobRepository.delete(req.tenant.id, req.params.id);
  if (!removed) return res.status(404).json({ error: 'Job not found' });
  EstimateRepository.deleteAllForJob(req.tenant.id, req.params.id);
  TimeEntryRepository.deleteAllForJob(req.tenant.id, req.params.id);
  res.status(204).send();
});

module.exports = router;
