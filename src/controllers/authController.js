const TenantRepository = require('../models/Tenant');
const UserRepository = require('../models/User');
const RefreshTokenRepository = require('../models/RefreshToken');
const TokenBlocklist = require('../models/TokenBlocklist');
const { signToken } = require('../utils/jwt');
const { encodeState, decodeState } = require('../utils/oauthState');

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Finds an existing user for this tenant+provider, or creates one.
 * Matches first on provider identity, falling back to email so a user who
 * previously signed up with Google and later uses GitHub with the same
 * email is linked to the same tenant account rather than duplicated. This
 * is also how a pending invite (created with no provider identity yet) gets
 * activated on the invitee's first real login.
 *
 * The very first user ever created for a tenant (i.e. not via invite) is
 * made 'owner' so a newly created tenant always has someone who can manage
 * it -- everyone after that defaults to 'member'.
 *
 * Exported standalone (not inline in the passport callback) so it can be
 * unit tested without needing a real OAuth handshake.
 */
function findOrCreateUser({ tenantId, provider, providerId, email, displayName, avatarUrl }) {
  if (!tenantId) {
    throw new Error('tenantId is required');
  }

  const tenant = TenantRepository.findById(tenantId);
  if (!tenant) {
    throw new Error(`Unknown tenant: ${tenantId}`);
  }

  const existingByProvider = UserRepository.findByProviderId(tenantId, provider, providerId);
  if (existingByProvider) {
    return existingByProvider;
  }

  const existingByEmail = email ? UserRepository.findByEmail(tenantId, email) : null;
  if (existingByEmail) {
    return UserRepository.linkProviderIdentity(tenantId, existingByEmail.id, {
      provider,
      providerId,
      displayName,
      avatarUrl
    });
  }

  const isFirstMember = UserRepository.countByTenant(tenantId) === 0;

  return UserRepository.create({
    tenantId,
    provider,
    providerId,
    email,
    displayName,
    avatarUrl,
    role: isFirstMember ? 'owner' : 'member',
    status: 'active'
  });
}

/** Issues a single API JWT for an already-resolved user (no refresh token). */
function issueTokenForUser(user) {
  return signToken(
    {
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      provider: user.provider
    },
    {}
  );
}

/**
 * Issues a full session: a short-lived access token plus a longer-lived
 * refresh token. This is what login and /auth/refresh should hand back.
 */
function issueTokenPair(user) {
  const accessToken = signToken({
    userId: user.id,
    tenantId: user.tenantId,
    email: user.email,
    provider: user.provider,
    role: user.role
  });

  const { token: refreshToken } = RefreshTokenRepository.create({
    tenantId: user.tenantId,
    userId: user.id
  });

  return { accessToken, refreshToken, tokenType: 'Bearer' };
}

/**
 * Exchanges a valid, unrevoked refresh token for a new token pair. The old
 * refresh token is revoked in the process (rotation) so a stolen-but-unused
 * refresh token can't be replayed after the legitimate client refreshes.
 */
function refreshAccessToken(rawRefreshToken) {
  if (!rawRefreshToken) {
    throw httpError('refreshToken is required', 400);
  }

  const record = RefreshTokenRepository.findValid(rawRefreshToken);
  if (!record) {
    throw httpError('Invalid or expired refresh token', 401);
  }

  const user = UserRepository.findById(record.tenantId, record.userId);
  if (!user) {
    throw httpError('User no longer exists', 401);
  }

  RefreshTokenRepository.revoke(rawRefreshToken);
  return issueTokenPair(user);
}

/**
 * Ends a session. Always blocklists the current access token's jti (if
 * provided) so it stops working immediately rather than lingering until it
 * naturally expires. Revokes either the single supplied refresh token, or
 * every refresh token for the user if `everywhere` is set (logout on all
 * devices).
 */
function logout({ refreshToken, accessTokenPayload, everywhere }) {
  let revokedRefreshCount = 0;

  if (everywhere && accessTokenPayload) {
    revokedRefreshCount = RefreshTokenRepository.revokeAllForUser(
      accessTokenPayload.tenantId,
      accessTokenPayload.userId
    );
  } else if (refreshToken) {
    revokedRefreshCount = RefreshTokenRepository.revoke(refreshToken) ? 1 : 0;
  }

  if (accessTokenPayload && accessTokenPayload.jti && accessTokenPayload.exp) {
    TokenBlocklist.revoke(accessTokenPayload.jti, new Date(accessTokenPayload.exp * 1000).toISOString());
  }

  return { revokedRefreshCount };
}

module.exports = {
  findOrCreateUser,
  issueTokenForUser,
  issueTokenPair,
  refreshAccessToken,
  logout,
  encodeState,
  decodeState
};
