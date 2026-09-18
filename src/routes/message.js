const express = require('express');
const tenantResolver = require('../middleware/tenantResolver');
const { requireAuth } = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { PERMISSIONS } = require('../config/permissions');
const MessageRepository = require('../models/Message');
const AuditLogRepository = require('../models/AuditLog');
const { redactMessageContent } = require('../services/redaction');
const { sendMessage } = require('../controllers/messagingController');

const router = express.Router();

router.use(tenantResolver());
router.use(requireAuth);

/**
 * Redacts message content only during an impersonation session
 * (req.currentUser.impersonation, set by requirePermission's
 * impersonation fallback -- a tenant's own real members never hit this
 * branch). `?reveal=true` returns the real content and logs a
 * `reveal_financials` audit entry (the same action name used for
 * cost/PII reveals elsewhere -- this is "sensitive content", the ledger
 * doesn't need a whole new category for it).
 */
function presentMessage(req, message) {
  if (!req.currentUser || !req.currentUser.impersonation) return message;

  const reveal = req.query.reveal === 'true';
  if (reveal) {
    AuditLogRepository.record({
      actorUserId: req.user.userId,
      actorHomeTenantId: req.user.impersonation.homeTenantId,
      targetTenantId: req.tenant.id,
      action: 'reveal_financials',
      resourceType: 'message',
      resourceId: message.id
    });
  }
  return redactMessageContent(message, { reveal });
}

/** GET /messages?customerId=&jobId= -- list, optionally filtered. */
router.get('/', requirePermission(PERMISSIONS.MESSAGES_READ), (req, res) => {
  const { customerId, jobId } = req.query;
  let messages;
  if (jobId) {
    messages = MessageRepository.listByJob(req.tenant.id, jobId);
  } else if (customerId) {
    messages = MessageRepository.listByCustomer(req.tenant.id, customerId);
  } else {
    messages = MessageRepository.listByTenant(req.tenant.id);
  }

  messages = messages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(messages.map((m) => presentMessage(req, m)));
});

router.get('/:id', requirePermission(PERMISSIONS.MESSAGES_READ), (req, res) => {
  const message = MessageRepository.findById(req.tenant.id, req.params.id);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  res.json(presentMessage(req, message));
});

/** POST /messages  { customerId, jobId?, body } -- send an SMS through whichever provider is currently configured (see services/sms/). */
router.post('/', requirePermission(PERMISSIONS.MESSAGES_SEND), async (req, res, next) => {
  try {
    const message = await sendMessage(req.tenant.id, { ...req.body, createdBy: req.user.userId });
    res.status(201).json(presentMessage(req, message));
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

module.exports = router;
