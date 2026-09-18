const SmsProvider = require('../SmsProvider');

/**
 * Twilio adapter. Requires the `twilio` package (`npm install twilio`),
 * lazily required -- see TelnyxProvider.js for why.
 *
 * Config (env vars, see .env.example):
 *   TWILIO_ACCOUNT_SID (required)
 *   TWILIO_AUTH_TOKEN (required)
 */
class TwilioProvider extends SmsProvider {
  constructor({ accountSid, authToken } = {}) {
    super();
    this.accountSid = accountSid;
    this.authToken = authToken;
    this._client = null;
    this._sdk = null;
  }

  get name() {
    return 'twilio';
  }

  _getSdk() {
    if (this._sdk) return this._sdk;
    try {
      // eslint-disable-next-line global-require, import/no-unresolved
      this._sdk = require('twilio');
    } catch (err) {
      throw new Error('The "twilio" package is not installed. Run: npm install twilio');
    }
    return this._sdk;
  }

  _getClient() {
    if (this._client) return this._client;
    if (!this.accountSid || !this.authToken) throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are not set');

    const twilio = this._getSdk();
    this._client = twilio(this.accountSid, this.authToken);
    return this._client;
  }

  async send({ to, from, text }) {
    const client = this._getClient();
    const response = await client.messages.create({ to, from, body: text });
    return { providerMessageId: response.sid, status: 'queued', raw: response };
  }

  /**
   * Twilio webhooks are form-encoded with PascalCase field names.
   * `Body` is the message text on the inbound-message webhook.
   */
  parseInboundWebhook(rawBody) {
    const body = rawBody || {};
    return {
      fromNumber: body.From,
      toNumber: body.To,
      text: body.Body,
      providerMessageId: body.MessageSid,
      receivedAt: new Date().toISOString()
    };
  }

  parseStatusWebhook(rawBody) {
    const body = rawBody || {};
    const statusMap = {
      queued: 'sent',
      sending: 'sent',
      sent: 'sent',
      delivered: 'delivered',
      undelivered: 'failed',
      failed: 'failed'
    };
    return {
      providerMessageId: body.MessageSid,
      status: statusMap[(body.MessageStatus || '').toLowerCase()] || 'sent',
      errorMessage: body.ErrorCode ? `Twilio error ${body.ErrorCode}` : null
    };
  }

  /**
   * Delegates to Twilio's own SDK helper (`twilio.validateRequest`)
   * rather than reimplementing their HMAC-SHA1-over-URL-and-params scheme
   * -- when the vendor ships a signature-verification helper, trust that
   * over hand-rolled crypto. Needs the exact URL the webhook was posted to.
   */
  verifyWebhookSignature(rawBody, headers = {}, fullUrl) {
    const signature = headers['x-twilio-signature'];
    if (!signature) return { verified: false, reason: 'missing X-Twilio-Signature header' };
    if (!fullUrl) return { verified: false, reason: 'fullUrl (the exact webhook URL) is required to verify a Twilio signature' };
    if (!this.authToken) return { verified: false, reason: 'TWILIO_AUTH_TOKEN not configured' };

    const twilio = this._getSdk();
    const isValid = twilio.validateRequest(this.authToken, signature, fullUrl, rawBody || {});
    return { verified: isValid, reason: isValid ? undefined : 'signature mismatch' };
  }
}

module.exports = TwilioProvider;
