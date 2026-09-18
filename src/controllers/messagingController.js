const CustomerRepository = require('../models/Customer');
const JobRepository = require('../models/Job');
const TenantRepository = require('../models/Tenant');
const MessageRepository = require('../models/Message');
const { getSmsProvider, getSmsProviderByName } = require('../services/sms');

function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * Sends an SMS to a customer (optionally about a specific job) through
 * whichever provider is currently configured (see services/sms/) and
 * records it. The request itself "succeeding" (a Message row gets
 * created) is separate from the SMS actually going out -- if the
 * provider's send() call fails, this returns the message with
 * status: 'failed' and an errorMessage rather than throwing, the same
 * way a real provider's own API responds (a 201 for the API call, with
 * delivery failure surfacing as a status change afterward).
 */
async function sendMessage(tenantId, { customerId, jobId, body, createdBy }) {
  if (!body) throw badRequest('body is required');

  const customer = CustomerRepository.findById(tenantId, customerId);
  if (!customer) throw notFound('Customer not found');
  if (!customer.phone) throw badRequest('This customer has no phone number on file');

  if (jobId) {
    const job = JobRepository.findById(tenantId, jobId);
    if (!job) throw notFound('Job not found');
    if (job.customerId !== customerId) throw badRequest('That job does not belong to this customer');
  }

  const fromNumber = process.env.SMS_FROM_NUMBER;
  if (!fromNumber) throw Object.assign(new Error('SMS_FROM_NUMBER is not configured'), { status: 500 });

  const provider = getSmsProvider();
  const message = MessageRepository.create({
    tenantId,
    customerId,
    jobId,
    body,
    fromNumber,
    toNumber: customer.phone,
    provider: provider.name,
    createdBy
  });

  try {
    const result = await provider.send({ to: customer.phone, from: fromNumber, text: body });
    MessageRepository.setProviderMessageId(message.id, result.providerMessageId);
    return MessageRepository.updateStatus(message.id, { status: result.status || 'sent' });
  } catch (err) {
    return MessageRepository.updateStatus(message.id, { status: 'failed', errorMessage: err.message });
  }
}

/**
 * Normalizes and records an inbound SMS from a provider's webhook, and
 * matches it to a tenant+customer by phone number -- the only way to,
 * since this app has one global SMS_FROM_NUMBER shared by every tenant
 * rather than a number per tenant (see models/Message.js). Zero or more
 * than one match is recorded as 'unmatched'/'ambiguous' rather than
 * guessed at; see GET /platform-admin/messages/unmatched to reconcile
 * those by hand.
 */
function handleInboundWebhook(providerName, rawBody, headers) {
  const provider = getSmsProviderByName(providerName);
  const parsed = provider.parseInboundWebhook(rawBody, headers);

  const matches = CustomerRepository.findAllByPhone(parsed.fromNumber);
  let tenantId = null;
  let customerId = null;
  let matchStatus = 'unmatched';
  if (matches.length === 1) {
    tenantId = matches[0].tenantId;
    customerId = matches[0].id;
    matchStatus = 'matched';
  } else if (matches.length > 1) {
    matchStatus = 'ambiguous';
  }

  return MessageRepository.createInbound({
    tenantId,
    customerId,
    body: parsed.text,
    fromNumber: parsed.fromNumber,
    toNumber: parsed.toNumber,
    provider: provider.name,
    providerMessageId: parsed.providerMessageId,
    matchStatus
  });
}

/**
 * Updates a message's delivery status from a provider's status/DLR
 * webhook. Returns null if no message with that provider message ID is
 * known (e.g. a stray or misdirected webhook) rather than throwing --
 * webhook endpoints should be forgiving of traffic they can't fully
 * place, not 500 on it.
 */
function handleStatusWebhook(providerName, rawBody, headers) {
  const provider = getSmsProviderByName(providerName);
  const parsed = provider.parseStatusWebhook(rawBody, headers);
  if (!parsed.providerMessageId) return null;

  const message = MessageRepository.findByProviderMessageId(parsed.providerMessageId);
  if (!message) return null;

  return MessageRepository.updateStatus(message.id, { status: parsed.status, errorMessage: parsed.errorMessage });
}

/** Manually attaches a previously-unmatched/ambiguous inbound message to the right tenant/customer, e.g. after a platform admin looks it up by hand. */
function reconcileMessage(id, { tenantId, customerId, jobId }) {
  const tenant = TenantRepository.findById(tenantId);
  if (!tenant) throw notFound('Tenant not found');
  const customer = CustomerRepository.findById(tenantId, customerId);
  if (!customer) throw notFound('Customer not found in that tenant');
  if (jobId) {
    const job = JobRepository.findById(tenantId, jobId);
    if (!job) throw notFound('Job not found in that tenant');
  }

  const message = MessageRepository.reconcile(id, { tenantId, customerId, jobId });
  if (!message) throw notFound('Message not found');
  return message;
}

module.exports = { sendMessage, handleInboundWebhook, handleStatusWebhook, reconcileMessage };
