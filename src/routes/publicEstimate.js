const express = require('express');
const EstimateRepository = require('../models/Estimate');
const { isPastValidity } = require('../models/Estimate');
const { buildCustomerView, recordApproval, recordRejection } = require('../controllers/estimateController');

/**
 * Public, UNAUTHENTICATED customer-facing routes -- deliberately mounted
 * without tenantResolver or requireAuth. A customer clicking an emailed
 * link has no login and shouldn't need one; the estimate's `shareToken`
 * (an unguessable random UUID) is the entire security boundary here, the
 * same opaque-token pattern this app already uses for refresh tokens.
 *
 * These handlers NEVER return anything but the sanitized customer view --
 * no cost, markup, margin, or internal notes ever reach this router.
 *
 * Hardening note (see README): add rate limiting on these routes before
 * production, since the token is a bearer secret and this is otherwise a
 * public, unauthenticated surface.
 */
const router = express.Router();

router.get('/:shareToken', (req, res) => {
  const estimate = EstimateRepository.findByShareToken(req.params.shareToken);
  if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
  res.json(buildCustomerView(estimate));
});

router.post('/:shareToken/approve', (req, res, next) => {
  const estimate = EstimateRepository.findByShareToken(req.params.shareToken);
  if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

  if (isPastValidity(estimate)) {
    return res.status(410).json({ error: 'This estimate has expired. Please request an updated one.' });
  }

  try {
    const approved = recordApproval(estimate.tenantId, estimate.id, req.body || {});
    res.json(buildCustomerView(approved));
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

router.post('/:shareToken/reject', (req, res, next) => {
  const estimate = EstimateRepository.findByShareToken(req.params.shareToken);
  if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

  if (isPastValidity(estimate)) {
    return res.status(410).json({ error: 'This estimate has expired. Please request an updated one.' });
  }

  try {
    const rejected = recordRejection(estimate.tenantId, estimate.id, req.body || {});
    res.json(buildCustomerView(rejected));
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

module.exports = router;
