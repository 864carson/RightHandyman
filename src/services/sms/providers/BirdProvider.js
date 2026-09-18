const { createHmac, timingSafeEqual } = require('crypto');
const SmsProvider = require('../SmsProvider');

/**
 * Bird (formerly MessageBird) adapter. Requires the `messagebird` package
 * (`npm install messagebird`), lazily required -- see TelnyxProvider.js
 * for why. Bird's SDK still uses the legacy MessageBird callback-style
 * API rather than promises, wrapped here.
 *
 * Config (env vars, see .env.example):
 *   BIRD_ACCESS_KEY (required)
 *   BIRD_SIGNING_KEY (optional -- enables webhook signature verification)
 */
class BirdProvider extends SmsProvider {
  constructor({ accessKey, signingKey } = {}) {
    super();
    this.accessKey = accessKey;
    this.signingKey = signingKey || null;
    this._client = null;
  }

  get name() {
    return 'bird';
  }

  _getClient() {
    if (this._client) return this._client;
    if (!this.accessKey) throw new Error('BIRD_ACCESS_KEY is not set');

    let messagebird;
    try {
      // eslint-disable-next-line global-require, import/no-unresolved
      messagebird = require('messagebird');
    } catch (err) {
      throw new Error('The "messagebird" package is not installed. Run: npm install messagebird');
    }
    this._client = messagebird.initClient(this.accessKey);
    return this._client;
  }

  send({ to, from, text }) {
    const client = this._getClient();
    // The SDK is callback-based -- wrap it in a Promise so this adapter's
    // interface matches every other one.
    return new Promise((resolve, reject) => {
      client.messages.create({ originator: from, recipients: [to], body: text }, (err, response) => {
        if (err) return reject(err);
        resolve({ providerMessageId: response.id, status: 'queued', raw: response });
      });
    });
  }

  /**
   * Bird's inbound-message webhook payload -- verify field names against
   * current Bird docs before production, this provider rebranded from
   * MessageBird fairly recently and API shapes may still be in flux.
   */
  parseInboundWebhook(rawBody) {
    const body = rawBody || {};
    return {
      fromNumber: body.originator,
      toNumber: body.recipient,
      text: body.body || body.payload,
      providerMessageId: body.id,
      receivedAt: new Date().toISOString()
    };
  }

  parseStatusWebhook(rawBody) {
    const body = rawBody || {};
    const statusMap = { scheduled: 'sent', sent: 'sent', buffered: 'sent', delivered: 'delivered', delivery_failed: 'failed', expired: 'failed' };
    return {
      providerMessageId: body.id,
      status: statusMap[body.status] || 'sent',
      errorMessage: body.statusErrorCode ? `Bird error code ${body.statusErrorCode}` : null
    };
  }

  /**
   * Best-effort HMAC-SHA256 signature check using BIRD_SIGNING_KEY against
   * a `Bird-Signature` header. Bird's exact signing scheme (which header,
   * whether it signs the raw body or a timestamp+body combo) was not
   * confirmed against live/current documentation -- treat this as a
   * starting point to verify, not a guarantee, before relying on it in
   * production.
   */
  verifyWebhookSignature(rawBody, headers = {}) {
    if (!this.signingKey) return { verified: false, reason: 'BIRD_SIGNING_KEY not configured' };
    const signature = headers['bird-signature'] || headers['messagebird-signature'];
    if (!signature) return { verified: false, reason: 'missing signature header' };

    try {
      const raw = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
      const expected = createHmac('sha256', this.signingKey).update(raw).digest('hex');
      const expectedBuf = Buffer.from(expected);
      const signatureBuf = Buffer.from(signature);
      if (expectedBuf.length !== signatureBuf.length) return { verified: false, reason: 'signature mismatch' };
      const isValid = timingSafeEqual(expectedBuf, signatureBuf);
      return { verified: isValid, reason: isValid ? undefined : 'signature mismatch' };
    } catch (err) {
      return { verified: false, reason: `verification error: ${err.message}` };
    }
  }
}

module.exports = BirdProvider;
