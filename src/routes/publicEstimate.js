const express = require('express');
const EstimateRepository = require('../models/Estimate');
const { isPastValidity } = require('../models/Estimate');
const { buildCustomerView, recordAcceptanceEvent } = require('../controllers/estimateController');
const createRateLimiter = require('../middleware/rateLimit');

/**
 * Public, UNAUTHENTICATED customer-facing routes -- deliberately mounted
 * without tenantResolver or requireAuth. A customer clicking an emailed
 * link has no login and shouldn't need one; the estimate's share token
 * (an unguessable random value, only its hash ever persisted -- see
 * models/Estimate.js / utils/tokenHash.js) is the entire security
 * boundary here, the same opaque-token pattern this app already uses for
 * refresh tokens.
 *
 * These handlers NEVER return anything but the sanitized customer view --
 * no cost, markup, margin, or internal notes ever reach this router.
 *
 * Digital acceptance: a typed full name + explicit "I agree" action is
 * legally sufficient under UETA/E-SIGN for the vast majority of B2B
 * estimates -- no drawn signature or per-envelope e-sign fee needed unless
 * your industry/contract specifically requires one. Every accept/reject
 * is permanently recorded (name, email, IP, user agent, which token was
 * used) in models/EstimateAcceptance.js, separately from the estimate's
 * own approvedBy/rejectedBy fields, which only reflect its current state.
 */
const router = express.Router();

// Generous view limit (customers legitimately reopen a link several
// times before deciding); much stricter on the action itself, which is
// the sensitive, state-changing operation.
const viewLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 60 });
const actionLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

router.get('/:shareToken', viewLimiter, (req, res) => {
  const estimate = EstimateRepository.findByShareToken(req.params.shareToken);
  if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

  EstimateRepository.recordView(estimate.tenantId, estimate.id);
  res.json(buildCustomerView(estimate));
});

router.post('/:shareToken/approve', actionLimiter, (req, res, next) => {
  const estimate = EstimateRepository.findByShareToken(req.params.shareToken);
  if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

  if (isPastValidity(estimate)) {
    return res.status(410).json({ error: 'This estimate has expired. Please request an updated one.' });
  }

  const { name, approvedByName, email } = req.body || {};
  const typedName = name || approvedByName; // approvedByName kept as an alias for backward compatibility
  if (!typedName) {
    return res.status(400).json({ error: 'A typed name is required to accept this estimate.' });
  }

  try {
    const { estimate: updated } = recordAcceptanceEvent(estimate.tenantId, estimate.id, {
      action: 'accepted',
      name: typedName,
      email,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      tokenLast8: req.params.shareToken.slice(-8)
    });
    res.json(buildCustomerView(updated));
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

router.post('/:shareToken/reject', actionLimiter, (req, res, next) => {
  const estimate = EstimateRepository.findByShareToken(req.params.shareToken);
  if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

  if (isPastValidity(estimate)) {
    return res.status(410).json({ error: 'This estimate has expired. Please request an updated one.' });
  }

  const { name, email, reason } = req.body || {};
  if (!name) {
    return res.status(400).json({ error: 'A typed name is required to reject this estimate.' });
  }

  try {
    const { estimate: updated } = recordAcceptanceEvent(estimate.tenantId, estimate.id, {
      action: 'rejected',
      name,
      email,
      reason,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      tokenLast8: req.params.shareToken.slice(-8)
    });
    res.json(buildCustomerView(updated));
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

// Test-only hook: clears both rate limiters' counters so test files that
// exercise these routes repeatedly don't trip limits meant for real
// traffic. Production code never calls this.
router.resetRateLimits = () => {
  viewLimiter.reset();
  actionLimiter.reset();
};

module.exports = router;
