const { createHmac } = require('crypto');
const SmsProvider = require('../SmsProvider');

/**
 * Plivo adapter. Requires the `plivo` package (`npm install plivo`),
 * lazily required -- see TelnyxProvider.js for why.
 *
 * Config (env vars, see .env.example):
 *   PLIVO_AUTH_ID (required)
 *   PLIVO_AUTH_TOKEN (required)
 */
class PlivoProvider extends SmsProvider {
  constructor({ authId, authToken } = {}) {
    super();
    this.authId = authId;
    this.authToken = authToken;
    this._client = null;
  }

  get name() {
    return 'plivo';
  }

  _getClient() {
    if (this._client) return this._client;
    if (!this.authId || !this.authToken) throw new Error('PLIVO_AUTH_ID and PLIVO_AUTH_TOKEN are not set');

    let plivo;
    try {
      // eslint-disable-next-line global-require, import/no-unresolved
      plivo = require('plivo');
    } catch (err) {
      throw new Error('The "plivo" package is not installed. Run: npm install plivo');
    }
    this._client = new plivo.Client(this.authId, this.authToken);
    return this._client;
  }

  async send({ to, from, text }) {
    const client = this._getClient();
    const response = await client.messages.create({ src: from, dst: to, text });
    // Plivo can split a long message into multiple parts, each with its
    // own UUID -- messageUuid is an array; the first part's ID is used as
    // this message's canonical id.
    const providerMessageId = Array.isArray(response.messageUuid) ? response.messageUuid[0] : response.messageUuid;
    return { providerMessageId, status: 'queued', raw: response };
  }

  /**
   * Plivo webhooks are form-encoded (Express's urlencoded parser turns
   * them into a plain object) with PascalCase field names. Verify field
   * names against current Plivo docs before production.
   */
  parseInboundWebhook(rawBody) {
    const body = rawBody || {};
    return {
      fromNumber: body.From,
      toNumber: body.To,
      text: body.Text,
      providerMessageId: body.MessageUUID,
      receivedAt: new Date().toISOString()
    };
  }

  parseStatusWebhook(rawBody) {
    const body = rawBody || {};
    const statusMap = { queued: 'sent', sent: 'sent', delivered: 'delivered', undelivered: 'failed', failed: 'failed', rejected: 'failed' };
    return {
      providerMessageId: body.MessageUUID,
      status: statusMap[(body.Status || '').toLowerCase()] || 'sent',
      errorMessage: body.ErrorCode ? `Plivo error code ${body.ErrorCode}` : null
    };
  }

  /**
   * Plivo's V2 signature scheme HMACs the full callback URL concatenated
   * with the nonce, using PLIVO_AUTH_TOKEN as the key, compared against
   * the `X-Plivo-Signature-V2` header (with `X-Plivo-Signature-V2-Nonce`
   * as the nonce). This needs the exact URL the webhook was sent to
   * (`fullUrl`), which routes/smsWebhook.js must supply -- unlike Twilio,
   * Plivo signs the URL, not the raw body. Verify this against current
   * Plivo docs before production; this has not been checked against a
   * live webhook.
   */
  verifyWebhookSignature(rawBody, headers = {}, fullUrl) {
    const signature = headers['x-plivo-signature-v2'];
    const nonce = headers['x-plivo-signature-v2-nonce'];
    if (!signature || !nonce) return { verified: false, reason: 'missing signature headers' };
    if (!fullUrl) return { verified: false, reason: 'fullUrl (the exact callback URL) is required to verify a Plivo signature' };
    if (!this.authToken) return { verified: false, reason: 'PLIVO_AUTH_TOKEN not configured' };

    const expected = createHmac('sha256', this.authToken).update(fullUrl + nonce).digest('base64');
    const isValid = expected === signature;
    return { verified: isValid, reason: isValid ? undefined : 'signature mismatch' };
  }
}

module.exports = PlivoProvider;
