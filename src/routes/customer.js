const express = require('express');
const tenantResolver = require('../middleware/tenantResolver');
const { requireAuth } = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { PERMISSIONS } = require('../config/permissions');
const CustomerRepository = require('../models/Customer');
const OpportunityRepository = require('../models/Opportunity');

const router = express.Router();

router.use(tenantResolver());
router.use(requireAuth);

router.get('/', requirePermission(PERMISSIONS.CUSTOMERS_READ), (req, res) => {
  res.json(CustomerRepository.listByTenant(req.tenant.id));
});

router.get('/:id', requirePermission(PERMISSIONS.CUSTOMERS_READ), (req, res) => {
  const customer = CustomerRepository.findById(req.tenant.id, req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  res.json(customer);
});

/** Convenience: every opportunity attached to a given customer. */
router.get('/:id/opportunities', requirePermission(PERMISSIONS.CUSTOMERS_READ), (req, res) => {
  const customer = CustomerRepository.findById(req.tenant.id, req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  res.json(OpportunityRepository.listByCustomer(req.tenant.id, customer.id));
});

router.post('/', requirePermission(PERMISSIONS.CUSTOMERS_CREATE), (req, res) => {
  try {
    // tenantId/createdBy are set from the authenticated request, never from
    // the request body, so a client can't create a customer in someone
    // else's tenant or misattribute who created it.
    const customer = CustomerRepository.create({
      ...req.body,
      tenantId: req.tenant.id,
      createdBy: req.user.userId
    });
    res.status(201).json(customer);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/:id', requirePermission(PERMISSIONS.CUSTOMERS_UPDATE), (req, res) => {
  try {
    const updated = CustomerRepository.update(req.tenant.id, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Customer not found' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', requirePermission(PERMISSIONS.CUSTOMERS_DELETE), (req, res) => {
  const removed = CustomerRepository.delete(req.tenant.id, req.params.id);
  if (!removed) return res.status(404).json({ error: 'Customer not found' });
  // Cascade: a customer's opportunities don't make sense without it.
  OpportunityRepository.deleteAllForCustomer(req.tenant.id, req.params.id);
  res.status(204).send();
});

module.exports = router;
