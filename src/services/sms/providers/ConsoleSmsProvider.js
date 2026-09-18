const { randomUUID } = require('crypto');
const SmsProvider = require('../SmsProvider');

/**
 * The default provider (`SMS_PROVIDER` unset or `console`). Never calls
 * out to a real network -- it logs each message and keeps an in-memory
 * list so local development and tests can actually run without a
 * provider account, credentials, or network access. Never use this in
 * production; nothing it "sends" ever reaches a real phone.
 *
 * Its webhook format is this app's own simple shape (not modeled on any
 * real provider), since it exists for local testing, not for receiving
 * genuine carrier traffic:
 *   inbound: { from, to, text, messageId? }
 *   status:  { messageId, status, errorMessage? }
 */
class ConsoleSmsProvider extends SmsProvider {
  constructor() {
    super();
    this.sentMessages = [];
  }

  get name() {
    return 'console';
  }

  async send({ to, from, text }) {
    const providerMessageId = `console-${randomUUID()}`;
    const record = { to, from, text, providerMessageId, sentAt: new Date().toISOString() };
    this.sentMessages.push(record);
    // eslint-disable-next-line no-console
    console.log(`[ConsoleSmsProvider] ${from} -> ${to}: ${text} (id: ${providerMessageId})`);
    return { providerMessageId, status: 'sent', raw: record };
  }

  parseInboundWebhook(rawBody) {
    const body = rawBody || {};
    return {
      fromNumber: body.from,
      toNumber: body.to,
      text: body.text,
      providerMessageId: body.messageId || `console-inbound-${randomUUID()}`,
      receivedAt: new Date().toISOString()
    };
  }

  parseStatusWebhook(rawBody) {
    const body = rawBody || {};
    return { providerMessageId: body.messageId, status: body.status, errorMessage: body.errorMessage || null };
  }

  verifyWebhookSignature() {
    // No real security needed for a provider that only ever talks to
    // itself in dev/test -- always "verified".
    return { verified: true };
  }

  /** Test-only helpers -- not part of the SmsProvider interface. */
  reset() {
    this.sentMessages = [];
  }
}

module.exports = ConsoleSmsProvider;
