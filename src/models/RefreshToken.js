const crypto = require('crypto');
const { getStore } = require('./db');

function hashToken(token) {
  // Only the hash is stored, mirroring how you'd store refresh tokens
  // against a real DB -- a leaked DB row shouldn't hand out usable tokens.
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseDurationToMs(duration) {
  if (typeof duration === 'number') return duration * 1000;
  const match = String(duration).match(/^(\d+)(s|m|h|d)?$/);
  if (!match) throw new Error(`Invalid duration: ${duration}`);
  const n = parseInt(match[1], 10);
  const unit = match[2] || 's';
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  return n * mult;
}

class RefreshTokenRepository {
  /**
   * Issues a new refresh token for a user. Returns the raw token once --
   * only its hash is persisted, so it can never be re-displayed.
   */
  create({ tenantId, userId, expiresIn }) {
    if (!tenantId || !userId) {
      throw new Error('tenantId and userId are required to create a refresh token');
    }

    const store = getStore();
    const raw = crypto.randomBytes(40).toString('hex');
    const tokenHash = hashToken(raw);
    const ttlMs = parseDurationToMs(expiresIn || process.env.REFRESH_TOKEN_EXPIRES_IN || '30d');

    const record = {
      tokenHash,
      tenantId,
      userId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      revoked: false
    };

    store.refreshTokens.set(tokenHash, record);
    return { token: raw, record };
  }

  /** Returns the token's record if it exists, isn't revoked, and hasn't expired -- otherwise null. */
  findValid(rawToken) {
    if (!rawToken) return null;
    const store = getStore();
    const record = store.refreshTokens.get(hashToken(rawToken));
    if (!record) return null;
    if (record.revoked) return null;
    if (new Date(record.expiresAt).getTime() < Date.now()) return null;
    return record;
  }

  /** Revokes a single refresh token. Returns true if a matching token was found. */
  revoke(rawToken) {
    if (!rawToken) return false;
    const store = getStore();
    const record = store.refreshTokens.get(hashToken(rawToken));
    if (!record || record.revoked) return false;
    record.revoked = true;
    return true;
  }

  /** Revokes every active refresh token for a user in a tenant ("logout everywhere"). Returns count revoked. */
  revokeAllForUser(tenantId, userId) {
    const store = getStore();
    let count = 0;
    for (const record of store.refreshTokens.values()) {
      if (record.tenantId === tenantId && record.userId === userId && !record.revoked) {
        record.revoked = true;
        count += 1;
      }
    }
    return count;
  }
}

module.exports = new RefreshTokenRepository();
module.exports.RefreshTokenRepository = RefreshTokenRepository;
