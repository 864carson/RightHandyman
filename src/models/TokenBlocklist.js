const { getStore } = require('./db');

/**
 * Tracks access-token `jti`s that were explicitly revoked (logout) before
 * their natural JWT expiry. Entries can be dropped once expired since an
 * expired token would already fail JWT verification anyway.
 */
class TokenBlocklistRepository {
  revoke(jti, expiresAt) {
    if (!jti) return;
    const store = getStore();
    store.tokenBlocklist.set(jti, { expiresAt });
  }

  isRevoked(jti) {
    if (!jti) return false;
    const store = getStore();
    const entry = store.tokenBlocklist.get(jti);
    if (!entry) return false;

    if (entry.expiresAt && new Date(entry.expiresAt).getTime() < Date.now()) {
      store.tokenBlocklist.delete(jti);
      return false;
    }

    return true;
  }
}

module.exports = new TokenBlocklistRepository();
module.exports.TokenBlocklistRepository = TokenBlocklistRepository;
