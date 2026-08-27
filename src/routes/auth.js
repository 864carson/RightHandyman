const express = require('express');
const passport = require('passport');
const TenantRepository = require('../models/Tenant');
const { requireAuth } = require('../middleware/auth');
const {
  encodeState,
  issueTokenPair,
  refreshAccessToken,
  logout: performLogout
} = require('../controllers/authController');

const router = express.Router();

const SUPPORTED_PROVIDERS = {
  google: { scope: ['profile', 'email'] },
  github: { scope: ['user:email'] }
};

// Registered before the /:provider param route below -- otherwise
// "/auth/failure" would itself match /:provider with provider="failure".
router.get('/failure', (req, res) => {
  res.status(401).json({ error: 'OAuth authentication failed' });
});

/**
 * POST /auth/refresh  { refreshToken }
 * Exchanges a valid refresh token for a new access + refresh token pair.
 * The old refresh token is rotated out (revoked) as part of this call.
 */
router.post('/refresh', (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    const tokens = refreshAccessToken(refreshToken);
    res.json(tokens);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/logout  { refreshToken?, everywhere? }
 * Requires a valid access token. Revokes the given refresh token (or every
 * refresh token for the user, if `everywhere: true`) and blocklists the
 * current access token so it stops working immediately.
 */
router.post('/logout', requireAuth, (req, res, next) => {
  try {
    const { refreshToken, everywhere } = req.body || {};
    const result = performLogout({
      refreshToken,
      accessTokenPayload: req.user,
      everywhere: Boolean(everywhere)
    });
    res.json({ success: true, revokedRefreshTokens: result.revokedRefreshCount });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /auth/:provider?tenant=<slug-or-id>
 * Kicks off the OAuth handshake. The tenant is resolved up front and baked
 * into the `state` param so the callback knows which tenant to attach the
 * user to, without needing cookies/session to carry that context.
 */
router.get('/:provider', (req, res, next) => {
  const { provider } = req.params;
  const config = SUPPORTED_PROVIDERS[provider];

  if (!config) {
    return res.status(404).json({ error: `Unsupported provider: ${provider}` });
  }

  const tenantParam = req.query.tenant;
  const tenant = tenantParam
    ? TenantRepository.findBySlug(tenantParam) || TenantRepository.findById(tenantParam)
    : null;

  if (!tenant) {
    return res.status(400).json({ error: 'A valid ?tenant=<slug-or-id> query param is required' });
  }

  const state = encodeState({ tenantId: tenant.id });

  passport.authenticate(provider, { scope: config.scope, session: false, state })(req, res, next);
});

/**
 * GET /auth/:provider/callback
 * Provider redirects here after the user grants/denies access. Returns a
 * full session: a short-lived access token plus a refresh token.
 */
router.get('/:provider/callback', (req, res, next) => {
  const { provider } = req.params;

  if (!SUPPORTED_PROVIDERS[provider]) {
    return res.status(404).json({ error: `Unsupported provider: ${provider}` });
  }

  passport.authenticate(provider, { session: false, failureRedirect: '/auth/failure' }, (err, user) => {
    if (err) return next(err);
    if (!user) return res.status(401).json({ error: 'Authentication failed' });

    const tokens = issueTokenPair(user);
    res.json({
      ...tokens,
      user: {
        id: user.id,
        tenantId: user.tenantId,
        email: user.email,
        displayName: user.displayName,
        provider: user.provider,
        role: user.role
      }
    });
  })(req, res, next);
});

module.exports = router;
