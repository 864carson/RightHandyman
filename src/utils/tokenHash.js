const crypto = require('crypto');

/**
 * One-way hash for opaque bearer tokens (refresh tokens, estimate share
 * tokens, etc.) so only the hash is ever persisted -- a leaked DB row
 * shouldn't hand out a usable token, the same reasoning as hashing a
 * password. Deterministic (no per-call salt) is correct here: these are
 * high-entropy, randomly generated tokens looked up by exact value, not
 * low-entropy user-chosen secrets where salting matters.
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { hashToken };
