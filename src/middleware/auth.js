const { verifyToken } = require('../utils/jwt');
const TokenBlocklist = require('../models/TokenBlocklist');

/**
 * Requires a valid Bearer JWT. Attaches the decoded payload as req.user.
 *
 * If req.tenant has already been resolved (by tenantResolver), this also
 * enforces that the token's tenantId matches -- a token minted for one
 * tenant must never grant access under a different tenant's context.
 *
 * Also rejects tokens whose `jti` was explicitly revoked via logout, even
 * if the token itself hasn't naturally expired yet.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  if (payload.jti && TokenBlocklist.isRevoked(payload.jti)) {
    return res.status(401).json({ error: 'Token has been revoked' });
  }

  if (req.tenant && payload.tenantId !== req.tenant.id) {
    return res.status(403).json({ error: 'Token does not belong to this tenant' });
  }

  req.user = payload;
  next();
}

module.exports = { requireAuth };
