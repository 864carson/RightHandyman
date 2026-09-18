const { randomUUID } = require('crypto');
const { getStore } = require('./db');

/**
 * A Message is one SMS, in either direction, tied to a customer (and
 * optionally a specific job). `provider` records which SmsProvider
 * actually sent/received it (see services/sms/) purely for reference --
 * nothing here or anywhere else in the app branches on which provider a
 * message used, that's the whole point of the abstraction.
 *
 * Inbound messages are matched to a tenant+customer by phone number (see
 * controllers/messagingController.js) -- but this app has ONE global
 * SMS_FROM_NUMBER shared by every tenant (see README), not a number per
 * tenant, so that match can fail: zero customers with that phone number,
 * or more than one across different tenants. `matchStatus` records which
 * happened; `tenantId`/`customerId` are null until a message is matched
 * or manually reconciled (see reconcile()).
 */
const DIRECTIONS = ['outbound', 'inbound'];
const STATUSES = ['queued', 'sent', 'delivered', 'failed', 'received'];
const MATCH_STATUSES = ['matched', 'unmatched', 'ambiguous'];

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

class MessageRepository {
  /** An outbound message being sent right now -- tenantId/customerId are always known. */
  create({ tenantId, customerId, jobId, body, fromNumber, toNumber, provider, createdBy }) {
    if (!tenantId || !customerId || !body || !toNumber) {
      throw new Error('tenantId, customerId, body, and toNumber are required to create a message');
    }

    const store = getStore();
    const message = {
      id: randomUUID(),
      tenantId,
      customerId,
      jobId: jobId || null,
      direction: 'outbound',
      body,
      fromNumber: fromNumber || null,
      toNumber,
      status: 'queued',
      matchStatus: 'matched',
      provider: provider || null,
      providerMessageId: null,
      errorMessage: null,
      createdBy: createdBy || null,
      createdAt: new Date().toISOString()
    };

    store.messages.set(message.id, message);
    return message;
  }

  /**
   * An inbound message just received via a provider's webhook.
   * `matchStatus`/`tenantId`/`customerId` reflect whether
   * controllers/messagingController.js was able to identify exactly one
   * customer by phone number.
   */
  createInbound({ tenantId, customerId, jobId, body, fromNumber, toNumber, provider, providerMessageId, matchStatus }) {
    if (!body || !fromNumber) {
      throw new Error('body and fromNumber are required to record an inbound message');
    }
    if (matchStatus && !MATCH_STATUSES.includes(matchStatus)) {
      throw badRequest(`matchStatus must be one of: ${MATCH_STATUSES.join(', ')}`);
    }

    const store = getStore();
    const message = {
      id: randomUUID(),
      tenantId: tenantId || null,
      customerId: customerId || null,
      jobId: jobId || null,
      direction: 'inbound',
      body,
      fromNumber,
      toNumber: toNumber || null,
      status: 'received',
      matchStatus: matchStatus || (tenantId && customerId ? 'matched' : 'unmatched'),
      provider: provider || null,
      providerMessageId: providerMessageId || null,
      errorMessage: null,
      createdBy: null,
      createdAt: new Date().toISOString()
    };

    store.messages.set(message.id, message);
    return message;
  }

  findById(tenantId, id) {
    const store = getStore();
    const message = store.messages.get(id);
    if (!message || message.tenantId !== tenantId) return null;
    return message;
  }

  /**
   * Cross-tenant lookup by provider message ID -- a delivery-status
   * webhook only gives us the ID the provider assigned, not our tenant,
   * the same reasoning as Estimate.findByShareToken.
   */
  findByProviderMessageId(providerMessageId) {
    const store = getStore();
    return Array.from(store.messages.values()).find((m) => m.providerMessageId === providerMessageId) || null;
  }

  /** Sets providerMessageId right after a successful send() call. Not tenant-scoped -- an internal/webhook-adjacent call, see messagingController. */
  setProviderMessageId(id, providerMessageId) {
    const store = getStore();
    const message = store.messages.get(id);
    if (!message) return null;
    message.providerMessageId = providerMessageId;
    return message;
  }

  /**
   * Updates delivery status -- called from the status webhook path, which
   * only has a providerMessageId to go on, not a tenant context. Not
   * tenant-scoped for the same reason setProviderMessageId isn't; the
   * webhook signature check (see routes/smsWebhook.js) is the real
   * security boundary here, not tenant scoping.
   */
  updateStatus(id, { status, errorMessage } = {}) {
    const store = getStore();
    const message = store.messages.get(id);
    if (!message) return null;
    if (status && !STATUSES.includes(status)) {
      throw badRequest(`status must be one of: ${STATUSES.join(', ')}`);
    }

    if (status) message.status = status;
    if (errorMessage !== undefined) message.errorMessage = errorMessage;
    message.updatedAt = new Date().toISOString();
    return message;
  }

  listByCustomer(tenantId, customerId) {
    const store = getStore();
    return Array.from(store.messages.values()).filter((m) => m.tenantId === tenantId && m.customerId === customerId);
  }

  listByJob(tenantId, jobId) {
    const store = getStore();
    return Array.from(store.messages.values()).filter((m) => m.tenantId === tenantId && m.jobId === jobId);
  }

  listByTenant(tenantId) {
    const store = getStore();
    return Array.from(store.messages.values()).filter((m) => m.tenantId === tenantId);
  }

  /** Inbound messages that couldn't be matched to exactly one tenant+customer by phone number. Platform-wide -- these have no tenant by definition. */
  listUnmatched() {
    const store = getStore();
    return Array.from(store.messages.values()).filter((m) => m.matchStatus !== 'matched' && !m.tenantId);
  }

  /** Manually attaches a previously-unmatched inbound message to the right tenant/customer/job. */
  reconcile(id, { tenantId, customerId, jobId }) {
    if (!tenantId || !customerId) {
      throw new Error('tenantId and customerId are required to reconcile a message');
    }
    const store = getStore();
    const message = store.messages.get(id);
    if (!message) return null;

    message.tenantId = tenantId;
    message.customerId = customerId;
    if (jobId !== undefined) message.jobId = jobId;
    message.matchStatus = 'matched';
    message.updatedAt = new Date().toISOString();
    return message;
  }

  deleteAllForCustomer(tenantId, customerId) {
    const store = getStore();
    let count = 0;
    for (const message of this.listByCustomer(tenantId, customerId)) {
      store.messages.delete(message.id);
      count += 1;
    }
    return count;
  }

  deleteAllForJob(tenantId, jobId) {
    const store = getStore();
    let count = 0;
    for (const message of this.listByJob(tenantId, jobId)) {
      store.messages.delete(message.id);
      count += 1;
    }
    return count;
  }

  deleteAllForTenant(tenantId) {
    const store = getStore();
    let count = 0;
    for (const message of this.listByTenant(tenantId)) {
      store.messages.delete(message.id);
      count += 1;
    }
    return count;
  }
}

module.exports = new MessageRepository();
module.exports.MessageRepository = MessageRepository;
module.exports.DIRECTIONS = DIRECTIONS;
module.exports.STATUSES = STATUSES;
module.exports.MATCH_STATUSES = MATCH_STATUSES;
