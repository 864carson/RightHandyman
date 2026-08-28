const express = require('express');
const tenantResolver = require('../middleware/tenantResolver');
const { requireAuth } = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { PERMISSIONS } = require('../config/permissions');
const OpportunityRepository = require('../models/Opportunity');
const CustomerRepository = require('../models/Customer');
const { convertOpportunityToJob } = require('../controllers/estimateController');

const router = express.Router();

router.use(tenantResolver());
router.use(requireAuth);

/** GET /opportunities?customerId=<id> to filter to one customer's pipeline. */
router.get('/', requirePermission(PERMISSIONS.OPPORTUNITIES_READ), (req, res) => {
  const { customerId } = req.query;
  const opportunities = customerId
    ? OpportunityRepository.listByCustomer(req.tenant.id, customerId)
    : OpportunityRepository.listByTenant(req.tenant.id);
  res.json(opportunities);
});

router.get('/:id', requirePermission(PERMISSIONS.OPPORTUNITIES_READ), (req, res) => {
  const opportunity = OpportunityRepository.findById(req.tenant.id, req.params.id);
  if (!opportunity) return res.status(404).json({ error: 'Opportunity not found' });
  res.json(opportunity);
});

router.post('/', requirePermission(PERMISSIONS.OPPORTUNITIES_CREATE), (req, res) => {
  const { customerId } = req.body || {};

  if (customerId && !CustomerRepository.findById(req.tenant.id, customerId)) {
    return res.status(400).json({ error: `Unknown customerId: ${customerId}` });
  }

  try {
    const opportunity = OpportunityRepository.create({
      ...req.body,
      tenantId: req.tenant.id,
      createdBy: req.user.userId
    });
    res.status(201).json(opportunity);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/:id', requirePermission(PERMISSIONS.OPPORTUNITIES_UPDATE), (req, res) => {
  const { customerId } = req.body || {};

  if (customerId && !CustomerRepository.findById(req.tenant.id, customerId)) {
    return res.status(400).json({ error: `Unknown customerId: ${customerId}` });
  }

  try {
    const updated = OpportunityRepository.update(req.tenant.id, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Opportunity not found' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', requirePermission(PERMISSIONS.OPPORTUNITIES_DELETE), (req, res) => {
  const removed = OpportunityRepository.delete(req.tenant.id, req.params.id);
  if (!removed) return res.status(404).json({ error: 'Opportunity not found' });
  res.status(204).send();
});

/**
 * POST /opportunities/:id/convert-to-job  { title?, siteAddress?, description?, weatherSensitive?, weatherNotes?, notes?, photos? }
 * Converts this opportunity into a Job (the hub that will hold its
 * estimate(s), status, and eventually invoice). Marks the opportunity
 * 'won' as part of the conversion if it wasn't already -- converting it IS
 * the "we got the job" signal. Requires jobs:create, since the meaningful
 * output of this action is a new Job.
 */
router.post('/:id/convert-to-job', requirePermission(PERMISSIONS.JOBS_CREATE), (req, res, next) => {
  try {
    const job = convertOpportunityToJob(req.tenant.id, req.params.id, req.body || {}, req.user.userId);
    res.status(201).json(job);
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

module.exports = router;
