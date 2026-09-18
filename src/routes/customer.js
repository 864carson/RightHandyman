const express = require('express');
const tenantResolver = require('../middleware/tenantResolver');
const { requireAuth } = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { PERMISSIONS } = require('../config/permissions');
const CustomerRepository = require('../models/Customer');
const OpportunityRepository = require('../models/Opportunity');
const JobRepository = require('../models/Job');
const EstimateRepository = require('../models/Estimate');
const TimeEntryRepository = require('../models/TimeEntry');
const MessageRepository = require('../models/Message');
const AuditLogRepository = require('../models/AuditLog');
const { redactCustomerPII, redactMessageContent } = require('../services/redaction');

const router = express.Router();

router.use(tenantResolver());
router.use(requireAuth);

/**
 * Redacts PII only during an impersonation session (req.currentUser.impersonation
 * is set by requirePermission's impersonation fallback -- real tenant members
 * never hit this branch at all). `?reveal=true` returns the real data and
 * logs a `reveal_pii` audit entry against the target tenant.
 */
function presentCustomer(req, customer) {
  if (!req.currentUser || !req.currentUser.impersonation) return customer;

  const reveal = req.query.reveal === 'true';
  if (reveal) {
    AuditLogRepository.record({
      actorUserId: req.user.userId,
      actorHomeTenantId: req.user.impersonation.homeTenantId,
      targetTenantId: req.tenant.id,
      action: 'reveal_pii',
      resourceType: 'customer',
      resourceId: customer.id
    });
  }
  return redactCustomerPII(customer, { reveal });
}

router.get('/', requirePermission(PERMISSIONS.CUSTOMERS_READ), (req, res) => {
  res.json(CustomerRepository.listByTenant(req.tenant.id).map((c) => presentCustomer(req, c)));
});

router.get('/:id', requirePermission(PERMISSIONS.CUSTOMERS_READ), (req, res) => {
  const customer = CustomerRepository.findById(req.tenant.id, req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  res.json(presentCustomer(req, customer));
});

/** Convenience: every opportunity attached to a given customer. */
router.get('/:id/opportunities', requirePermission(PERMISSIONS.CUSTOMERS_READ), (req, res) => {
  const customer = CustomerRepository.findById(req.tenant.id, req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  res.json(OpportunityRepository.listByCustomer(req.tenant.id, customer.id));
});

/** Convenience: every job attached to a given customer -- the job:1234-style hub for that customer's history. */
router.get('/:id/jobs', requirePermission(PERMISSIONS.CUSTOMERS_READ), (req, res) => {
  const customer = CustomerRepository.findById(req.tenant.id, req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  res.json(JobRepository.listByCustomer(req.tenant.id, customer.id));
});

/** Convenience: every SMS ever sent to/received from a given customer, newest first. */
router.get('/:id/messages', requirePermission(PERMISSIONS.MESSAGES_READ), (req, res) => {
  const customer = CustomerRepository.findById(req.tenant.id, req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const messages = MessageRepository.listByCustomer(req.tenant.id, customer.id).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  const reveal = req.query.reveal === 'true';
  if (req.currentUser && req.currentUser.impersonation && reveal && messages.length > 0) {
    AuditLogRepository.record({
      actorUserId: req.user.userId,
      actorHomeTenantId: req.user.impersonation.homeTenantId,
      targetTenantId: req.tenant.id,
      action: 'reveal_financials',
      resourceType: 'customer-messages',
      resourceId: customer.id
    });
  }
  const impersonating = Boolean(req.currentUser && req.currentUser.impersonation);
  res.json(messages.map((m) => (impersonating ? redactMessageContent(m, { reveal }) : m)));
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
  // Cascade: a customer's opportunities and jobs (and every estimate
  // version + time entry under those jobs), plus every message ever sent
  // to/from them, don't make sense without the customer.
  OpportunityRepository.deleteAllForCustomer(req.tenant.id, req.params.id);
  for (const job of JobRepository.listByCustomer(req.tenant.id, req.params.id)) {
    EstimateRepository.deleteAllForJob(req.tenant.id, job.id);
    TimeEntryRepository.deleteAllForJob(req.tenant.id, job.id);
  }
  JobRepository.deleteAllForCustomer(req.tenant.id, req.params.id);
  MessageRepository.deleteAllForCustomer(req.tenant.id, req.params.id);
  res.status(204).send();
});

module.exports = router;
