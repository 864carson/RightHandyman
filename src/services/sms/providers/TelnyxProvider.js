const { verify: cryptoVerify } = require('crypto');
const SmsProvider = require('../SmsProvider');

/**
 * Telnyx adapter. Requires the `telnyx` package to be installed
 * separately (`npm install telnyx`) -- it's intentionally NOT a hard
 * dependency of this app, so installing five SDKs you'll never use isn't
 * the cost of picking one provider. Only lazily required the first time
 * this adapter is actually used.
 *
 * Config (env vars, see .env.example):
 *   TELNYX_API_KEY (required)
 *   TELNYX_MESSAGING_PROFILE_ID (optional -- set this up once in the
 *     Telnyx dashboard; without it, sends are attempted without a
 *     profile, which Telnyx may reject depending on your account setup)
 *   TELNYX_PUBLIC_KEY (optional -- enables webhook signature verification)
 */
class TelnyxProvider extends SmsProvider {
  constructor({ apiKey, messagingProfileId, publicKey } = {}) {
    super();
    this.apiKey = apiKey;
    this.messagingProfileId = messagingProfileId || null;
    this.publicKey = publicKey || null;
    this._client = null;
  }

  get name() {
    return 'telnyx';
  }

  _getClient() {
    if (this._client) return this._client;
    if (!this.apiKey) throw new Error('TELNYX_API_KEY is not set');

    let Telnyx;
    try {
      // eslint-disable-next-line global-require, import/no-unresolved
      ({ Telnyx } = require('telnyx'));
    } catch (err) {
      throw new Error('The "telnyx" package is not installed. Run: npm install telnyx');
    }
    this._client = new Telnyx(this.apiKey);
    return this._client;
  }

  async send({ to, from, text }) {
    const client = this._getClient();
    const payload = { from, to, text };
    if (this.messagingProfileId) payload.messaging_profile_id = this.messagingProfileId;

    const response = await client.messages.create(payload);
    return { providerMessageId: response.data.id, status: 'queued', raw: response };
  }

  /**
   * Telnyx webhooks wrap everything in { data: { event_type, payload } }.
   * `from`/`to` are objects ({ phone_number }) rather than bare strings --
   * verify against current Telnyx docs before production, message webhook
   * shapes are the part of any provider's API most likely to drift.
   */
  parseInboundWebhook(rawBody) {
    const payload = (rawBody && rawBody.data && rawBody.data.payload) || {};
    const toEntry = Array.isArray(payload.to) ? payload.to[0] : payload.to;
    return {
      fromNumber: payload.from && payload.from.phone_number,
      toNumber: toEntry && toEntry.phone_number,
      text: payload.text,
      providerMessageId: payload.id,
      receivedAt: payload.received_at || new Date().toISOString()
    };
  }

  parseStatusWebhook(rawBody) {
    const payload = (rawBody && rawBody.data && rawBody.data.payload) || {};
    const statusMap = { queued: 'sent', sending: 'sent', sent: 'sent', delivered: 'delivered', delivery_failed: 'failed', failed: 'failed' };
    return {
      providerMessageId: payload.id,
      status: statusMap[payload.to && payload.to[0] && payload.to[0].status] || statusMap[payload.status] || 'sent',
      errorMessage: payload.errors && payload.errors.length ? payload.errors.map((e) => e.detail).join('; ') : null
    };
  }

  /**
   * Telnyx signs webhooks with Ed25519 (a public-key signature, not a
   * shared-secret HMAC like most other providers) -- headers
   * `telnyx-signature-ed25519` and `telnyx-timestamp`, verifying
   * `${timestamp}|${rawBody}` against TELNYX_PUBLIC_KEY. Implemented with
   * Node's built-in crypto (no extra dependency), but double-check the
   * exact header names and signed-payload format against Telnyx's current
   * docs before relying on this in production -- this is implemented from
   * well-documented, stable API conventions, not verified against a live
   * webhook.
   */
  verifyWebhookSignature(rawBody, headers = {}) {
    if (!this.publicKey) return { verified: false, reason: 'TELNYX_PUBLIC_KEY not configured' };

    const signature = headers['telnyx-signature-ed25519'];
    const timestamp = headers['telnyx-timestamp'];
    if (!signature || !timestamp) return { verified: false, reason: 'missing signature headers' };

    try {
      const signedPayload = `${timestamp}|${typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody)}`;
      const publicKeyObject = {
        key: Buffer.from(this.publicKey, 'base64'),
        format: 'der',
        type: 'spki'
      };
      // Ed25519 verification is a single-shot operation in Node's crypto
      // (no createVerify().update() streaming API for it) -- pass null as
      // the algorithm per Node's documented ed25519 usage.
      const isValid = cryptoVerify(null, Buffer.from(signedPayload), publicKeyObject, Buffer.from(signature, 'base64'));
      return { verified: isValid, reason: isValid ? undefined : 'signature mismatch' };
    } catch (err) {
      return { verified: false, reason: `verification error: ${err.message}` };
    }
  }
}

module.exports = TelnyxProvider;
