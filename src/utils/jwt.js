const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set');
  }
  return secret;
}

/**
 * Signs a payload into a JWT. Always embeds tenantId and userId so every
 * downstream check can verify tenant isolation from the token alone, plus a
 * unique `jti` so this specific token can be revoked (logout) independently
 * of its natural expiry.
 *
 * Default expiry is short (15m) since this is meant to be an access token
 * paired with a longer-lived refresh token (see models/RefreshToken.js).
 */
function signToken(payload, options = {}) {
  if (!payload || !payload.tenantId || !payload.userId) {
    throw new Error('Token payload must include tenantId and userId');
  }

  const expiresIn = options.expiresIn || process.env.JWT_EXPIRES_IN || '15m';
  const jti = options.jti || randomUUID();
  return jwt.sign({ ...payload, jti }, getSecret(), { expiresIn });
}

/**
 * Verifies a JWT and returns its decoded payload.
 * Throws if the token is invalid, malformed, or expired.
 */
function verifyToken(token) {
  return jwt.verify(token, getSecret());
}

module.exports = { signToken, verifyToken };
