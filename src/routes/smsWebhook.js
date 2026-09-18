const express = require('express');
const createRateLimiter = require('../middleware/rateLimit');
const { getSmsProviderByName } = require('../services/sms');
const { handleInboundWebhook, handleStatusWebhook } = require('../controllers/messagingController');

/**
 * Public, UNAUTHENTICATED webhook receiver -- a provider calls these, not
 * a logged-in user, so there's no tenantResolver/requireAuth here (same
 * reasoning as routes/publicEstimate.js). The provider is named in the
 * URL (`/webhooks/sms/:provider/...`) rather than inferred from
 * SMS_PROVIDER, so switching your active outbound provider doesn't break
 * in-flight webhooks from whichever provider you were using a moment ago
 * -- see services/sms/index.js's getSmsProviderByName.
 *
 * Signature verification (see each adapter's verifyWebhookSignature) is
 * enforced when SMS_WEBHOOK_STRICT_VERIFICATION=true; otherwise an
 * unverified webhook is still processed but logged as a warning. Default
 * is permissive so a fresh setup isn't broken by a provider whose
 * signature scheme isn't (yet) implemented here -- flip on strict mode
 * once you've confirmed your provider's verification actually works (see
 * README hardening notes).
 */
const router = express.Router();
const webhookLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 120 });

function fullUrlFor(req) {
  return `${req.protocol}://${req.get('host')}${req.originalUrl}`;
}

function checkSignature(provider, req) {
  const result = provider.verifyWebhookSignature(req.body, req.headers, fullUrlFor(req));
  const strict = process.env.SMS_WEBHOOK_STRICT_VERIFICATION === 'true';

  if (result.verified) return { allowed: true };
  if (strict) return { allowed: false, reason: result.reason };

  // eslint-disable-next-line no-console
  console.warn(
    `[smsWebhook] Unverified ${provider.name} webhook (${result.reason}) -- processed anyway because SMS_WEBHOOK_STRICT_VERIFICATION is not "true".`
  );
  return { allowed: true };
}

router.post('/:provider/inbound', webhookLimiter, (req, res) => {
  let provider;
  try {
    provider = getSmsProviderByName(req.params.provider);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const signatureCheck = checkSignature(provider, req);
  if (!signatureCheck.allowed) {
    return res.status(401).json({ error: `Webhook signature verification failed: ${signatureCheck.reason}` });
  }

  try {
    handleInboundWebhook(req.params.provider, req.body, req.headers);
    // Providers generally just need a 200 to consider the webhook
    // delivered -- the response body content isn't meaningful to them.
    res.status(200).json({ received: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:provider/status', webhookLimiter, (req, res) => {
  let provider;
  try {
    provider = getSmsProviderByName(req.params.provider);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const signatureCheck = checkSignature(provider, req);
  if (!signatureCheck.allowed) {
    return res.status(401).json({ error: `Webhook signature verification failed: ${signatureCheck.reason}` });
  }

  try {
    handleStatusWebhook(req.params.provider, req.body, req.headers);
    res.status(200).json({ received: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Test-only hook, mirrors routes/publicEstimate.js's resetRateLimits pattern.
router.resetRateLimits = () => {
  webhookLimiter.reset();
};

module.exports = router;
