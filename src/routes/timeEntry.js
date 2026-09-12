const express = require('express');
const tenantResolver = require('../middleware/tenantResolver');
const { requireAuth } = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { PERMISSIONS } = require('../config/permissions');
const TimeEntryRepository = require('../models/TimeEntry');
const AuditLogRepository = require('../models/AuditLog');
const { redactTimeEntryFinancials } = require('../services/redaction');
const timeTrackingController = require('../controllers/timeTrackingController');

const router = express.Router();

router.use(tenantResolver());
router.use(requireAuth);

function presentEntry(req, entry) {
  if (!req.currentUser || !req.currentUser.impersonation) return entry;

  const reveal = req.query.reveal === 'true';
  if (reveal) {
    AuditLogRepository.record({
      actorUserId: req.user.userId,
      actorHomeTenantId: req.user.impersonation.homeTenantId,
      targetTenantId: req.tenant.id,
      action: 'reveal_financials',
      resourceType: 'time-entry',
      resourceId: entry.id
    });
  }
  return redactTimeEntryFinancials(entry, { reveal });
}

/**
 * POST /time-entries/clock-in  { jobId, notes? }
 * Self-service: clocks the CALLER in against a job. time-entries:log is
 * granted broadly (every member) -- this is a day-to-day field action, not
 * a payroll-visibility one.
 */
router.post('/clock-in', requirePermission(PERMISSIONS.TIME_ENTRIES_LOG), (req, res, next) => {
  const { jobId, notes } = req.body || {};
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });

  try {
    const entry = timeTrackingController.clockIn(req.tenant.id, jobId, req.user.userId, { notes });
    res.status(201).json(entry); // always the caller's own entry -- their own rates are not "someone else's payroll data"
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

/** POST /time-entries/clock-out  { notes? } -- closes whatever the caller is currently clocked into, wherever it is. */
router.post('/clock-out', requirePermission(PERMISSIONS.TIME_ENTRIES_LOG), (req, res, next) => {
  try {
    const entry = TimeEntryRepository.clockOut(req.tenant.id, req.user.userId, req.body || {});
    res.json(entry);
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

/** GET /time-entries/mine -- the caller's own history. Always available regardless of time-entries:read (it's their own data, not someone else's). */
router.get('/mine', requirePermission(PERMISSIONS.TIME_ENTRIES_LOG), (req, res) => {
  const entries = TimeEntryRepository.listByUser(req.tenant.id, req.user.userId).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  res.json(entries);
});

/** GET /time-entries/:id -- fetch any single entry (e.g. to review before editing). Payroll-adjacent, so time-entries:read. */
router.get('/:id', requirePermission(PERMISSIONS.TIME_ENTRIES_READ), (req, res) => {
  const entry = TimeEntryRepository.findById(req.tenant.id, req.params.id);
  if (!entry) return res.status(404).json({ error: 'Time entry not found' });
  res.json(presentEntry(req, entry));
});

/**
 * POST /time-entries/:id/force-clock-out  { notes? }
 * Manager-initiated close of a SPECIFIC entry -- e.g. an employee forgot
 * to clock out. Unlike /clock-out (which always targets the caller's own
 * active entry), this targets someone else's by id.
 */
router.post('/:id/force-clock-out', requirePermission(PERMISSIONS.TIME_ENTRIES_MANAGE), (req, res, next) => {
  try {
    const entry = TimeEntryRepository.forceClockOut(req.tenant.id, req.params.id, {
      notes: (req.body || {}).notes,
      closedBy: req.user.userId
    });
    if (!entry) return res.status(404).json({ error: 'Time entry not found' });
    res.json(presentEntry(req, entry));
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

/**
 * PATCH /time-entries/:id
 * Manager-only correction (notes, billable, rates, or clockIn/clockOut on
 * a completed entry) -- employees don't edit their own past entries
 * through this app, the same norm most time-tracking tools follow, so an
 * employee can't unilaterally inflate their own logged hours.
 */
router.patch('/:id', requirePermission(PERMISSIONS.TIME_ENTRIES_MANAGE), (req, res, next) => {
  try {
    const updated = TimeEntryRepository.update(req.tenant.id, req.params.id, req.body || {}, { editedBy: req.user.userId });
    if (!updated) return res.status(404).json({ error: 'Time entry not found' });
    res.json(presentEntry(req, updated));
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

router.delete('/:id', requirePermission(PERMISSIONS.TIME_ENTRIES_MANAGE), (req, res, next) => {
  try {
    const removed = TimeEntryRepository.delete(req.tenant.id, req.params.id);
    if (!removed) return res.status(404).json({ error: 'Time entry not found' });
    res.status(204).send();
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

module.exports = router;
