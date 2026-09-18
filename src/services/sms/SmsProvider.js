/**
 * The one interface the rest of this app is allowed to know about.
 * Nothing outside `src/services/sms/` ever imports a provider SDK
 * directly -- routes/controllers/models only ever call
 * `getSmsProvider()` (see index.js) and talk to whatever it returns
 * through these four methods. Swapping Telnyx for Twilio, or adding a
 * brand new provider, means writing one new adapter file and changing
 * an env var -- zero changes anywhere else in the app. That's the whole
 * point of this layer.
 *
 * Every adapter in providers/ extends this and implements all four
 * methods. A method left unimplemented throws clearly rather than
 * silently doing nothing, so a half-finished adapter fails loudly in
 * development instead of quietly dropping messages in production.
 */
class SmsProvider {
  /** Short, stable identifier used in Message.provider and log lines, e.g. 'telnyx'. */
  get name() {
    throw new Error(`${this.constructor.name} must implement get name()`);
  }

  /**
   * Sends one SMS. Must resolve to a normalized result on success:
   *   { providerMessageId: string, status: 'queued'|'sent', raw: <original SDK response> }
   * and must throw (or reject) on failure -- callers (messagingController)
   * catch that and record the message as 'failed' with the error message,
   * they never need to know *why* a specific provider failed.
   */
  // eslint-disable-next-line no-unused-vars
  async send({ to, from, text }) {
    throw new Error(`${this.constructor.name} must implement send()`);
  }

  /**
   * Normalizes a provider's inbound-message webhook payload into:
   *   { fromNumber, toNumber, text, providerMessageId, receivedAt }
   * `rawBody`/`headers` are whatever the webhook route received verbatim
   * (already JSON-parsed if the provider sends JSON, or the parsed
   * form-encoded body if it doesn't -- see routes/smsWebhook.js).
   */
  // eslint-disable-next-line no-unused-vars
  parseInboundWebhook(rawBody, headers) {
    throw new Error(`${this.constructor.name} must implement parseInboundWebhook()`);
  }

  /**
   * Normalizes a provider's delivery-status webhook payload into:
   *   { providerMessageId, status: 'sent'|'delivered'|'failed', errorMessage? }
   */
  // eslint-disable-next-line no-unused-vars
  parseStatusWebhook(rawBody, headers) {
    throw new Error(`${this.constructor.name} must implement parseStatusWebhook()`);
  }

  /**
   * Verifies a webhook actually came from this provider (HMAC/signature
   * check against the raw request body). Returns { verified: boolean,
   * reason?: string } rather than throwing, so routes/smsWebhook.js can
   * decide how strict to be (reject vs. log-and-continue) in one place.
   * Adapters that can't yet verify signatures return `{ verified: false,
   * reason: 'not implemented' }` -- see each adapter's own comment for
   * exactly how far its implementation goes.
   */
  // eslint-disable-next-line no-unused-vars
  verifyWebhookSignature(rawBody, headers) {
    return { verified: false, reason: 'not implemented for this provider' };
  }
}

module.exports = SmsProvider;
