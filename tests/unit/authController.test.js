const { resetWithTenant } = require('../helpers/setup');
const {
  findOrCreateUser,
  issueTokenForUser,
  issueTokenPair,
  refreshAccessToken,
  logout
} = require('../../src/controllers/authController');
const { verifyToken } = require('../../src/utils/jwt');
const UserRepository = require('../../src/models/User');
const RefreshTokenRepository = require('../../src/models/RefreshToken');
const TokenBlocklist = require('../../src/models/TokenBlocklist');

describe('authController.findOrCreateUser', () => {
  let tenant;

  beforeEach(() => {
    tenant = resetWithTenant();
  });

  test('creates a new user on first login', () => {
    const user = findOrCreateUser({
      tenantId: tenant.id,
      provider: 'google',
      providerId: 'g-1',
      email: 'jane@example.com',
      displayName: 'Jane Doe'
    });

    expect(user.id).toBeDefined();
    expect(user.tenantId).toBe(tenant.id);
    expect(UserRepository.listByTenant(tenant.id)).toHaveLength(1);
  });

  test('returns the same user on repeat login with same provider identity', () => {
    const first = findOrCreateUser({
      tenantId: tenant.id,
      provider: 'google',
      providerId: 'g-1',
      email: 'jane@example.com'
    });

    const second = findOrCreateUser({
      tenantId: tenant.id,
      provider: 'google',
      providerId: 'g-1',
      email: 'jane@example.com'
    });

    expect(second.id).toBe(first.id);
    expect(UserRepository.listByTenant(tenant.id)).toHaveLength(1);
  });

  test('links a different provider to an existing user by matching email', () => {
    const viaGoogle = findOrCreateUser({
      tenantId: tenant.id,
      provider: 'google',
      providerId: 'g-1',
      email: 'jane@example.com'
    });

    const viaGithub = findOrCreateUser({
      tenantId: tenant.id,
      provider: 'github',
      providerId: 'gh-99',
      email: 'jane@example.com'
    });

    // Matched by email, so it's the same underlying user record.
    expect(viaGithub.id).toBe(viaGoogle.id);
    expect(UserRepository.listByTenant(tenant.id)).toHaveLength(1);
  });

  test('throws for an unknown tenant', () => {
    expect(() =>
      findOrCreateUser({
        tenantId: 'does-not-exist',
        provider: 'google',
        providerId: 'g-1',
        email: 'jane@example.com'
      })
    ).toThrow(/Unknown tenant/);
  });

  test('throws when tenantId is missing', () => {
    expect(() =>
      findOrCreateUser({ provider: 'google', providerId: 'g-1', email: 'jane@example.com' })
    ).toThrow(/tenantId is required/);
  });
});

describe('authController.findOrCreateUser role assignment', () => {
  let tenant;

  beforeEach(() => {
    tenant = resetWithTenant();
  });

  test('the first user created for a tenant becomes owner', () => {
    const user = findOrCreateUser({
      tenantId: tenant.id,
      provider: 'google',
      providerId: 'g-1',
      email: 'first@example.com'
    });

    expect(user.role).toBe('owner');
  });

  test('subsequent users default to member', () => {
    findOrCreateUser({ tenantId: tenant.id, provider: 'google', providerId: 'g-1', email: 'first@example.com' });
    const second = findOrCreateUser({ tenantId: tenant.id, provider: 'google', providerId: 'g-2', email: 'second@example.com' });

    expect(second.role).toBe('member');
  });

  test('logging in with a matching email activates a pending invite', () => {
    const invited = UserRepository.create({ tenantId: tenant.id, email: 'invitee@example.com', status: 'invited', role: 'admin' });

    const activated = findOrCreateUser({
      tenantId: tenant.id,
      provider: 'google',
      providerId: 'g-1',
      email: 'invitee@example.com'
    });

    expect(activated.id).toBe(invited.id);
    expect(activated.status).toBe('active');
    expect(activated.role).toBe('admin'); // role from the invite is preserved
  });
});

describe('authController.issueTokenPair', () => {
  let tenant;
  let user;

  beforeEach(() => {
    tenant = resetWithTenant();
    user = findOrCreateUser({ tenantId: tenant.id, provider: 'google', providerId: 'g-1', email: 'jane@example.com' });
  });

  test('returns a verifiable access token and a usable refresh token', () => {
    const { accessToken, refreshToken, tokenType } = issueTokenPair(user);

    expect(tokenType).toBe('Bearer');
    const payload = verifyToken(accessToken);
    expect(payload.userId).toBe(user.id);
    expect(payload.role).toBe(user.role);

    expect(RefreshTokenRepository.findValid(refreshToken)).not.toBeNull();
  });
});

describe('authController.refreshAccessToken', () => {
  let tenant;
  let user;

  beforeEach(() => {
    tenant = resetWithTenant();
    user = findOrCreateUser({ tenantId: tenant.id, provider: 'google', providerId: 'g-1', email: 'jane@example.com' });
  });

  test('exchanges a valid refresh token for a new pair and rotates the old one', () => {
    const { refreshToken } = issueTokenPair(user);
    const rotated = refreshAccessToken(refreshToken);

    expect(rotated.accessToken).toBeDefined();
    expect(rotated.refreshToken).not.toBe(refreshToken);
    // Old refresh token no longer works.
    expect(RefreshTokenRepository.findValid(refreshToken)).toBeNull();
  });

  test('throws 400 when no refresh token is provided', () => {
    expect(() => refreshAccessToken(undefined)).toThrow(/required/);
    try {
      refreshAccessToken(undefined);
    } catch (err) {
      expect(err.status).toBe(400);
    }
  });

  test('throws 401 for an invalid or already-used refresh token', () => {
    const { refreshToken } = issueTokenPair(user);
    refreshAccessToken(refreshToken); // consumes it via rotation

    try {
      refreshAccessToken(refreshToken);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.status).toBe(401);
    }
  });
});

describe('authController.logout', () => {
  let tenant;
  let user;

  beforeEach(() => {
    tenant = resetWithTenant();
    user = findOrCreateUser({ tenantId: tenant.id, provider: 'google', providerId: 'g-1', email: 'jane@example.com' });
  });

  test('revokes the provided refresh token', () => {
    const { refreshToken } = issueTokenPair(user);

    const result = logout({ refreshToken, accessTokenPayload: null, everywhere: false });

    expect(result.revokedRefreshCount).toBe(1);
    expect(RefreshTokenRepository.findValid(refreshToken)).toBeNull();
  });

  test('everywhere: true revokes every refresh token for the user', () => {
    const first = issueTokenPair(user);
    const second = issueTokenPair(user);

    const result = logout({
      accessTokenPayload: { tenantId: tenant.id, userId: user.id },
      everywhere: true
    });

    expect(result.revokedRefreshCount).toBe(2);
    expect(RefreshTokenRepository.findValid(first.refreshToken)).toBeNull();
    expect(RefreshTokenRepository.findValid(second.refreshToken)).toBeNull();
  });

  test('blocklists the access token jti when payload has exp', () => {
    const futureExp = Math.floor(Date.now() / 1000) + 900;
    logout({ accessTokenPayload: { jti: 'jti-abc', exp: futureExp }, everywhere: false });

    expect(TokenBlocklist.isRevoked('jti-abc')).toBe(true);
  });
});

describe('authController.issueTokenForUser', () => {
  let tenant;

  beforeEach(() => {
    tenant = resetWithTenant();
  });

  test('issues a JWT embedding userId and tenantId', () => {
    const user = findOrCreateUser({
      tenantId: tenant.id,
      provider: 'google',
      providerId: 'g-1',
      email: 'jane@example.com'
    });

    const token = issueTokenForUser(user);
    const payload = verifyToken(token);

    expect(payload.userId).toBe(user.id);
    expect(payload.tenantId).toBe(tenant.id);
    expect(payload.email).toBe('jane@example.com');
  });
});
