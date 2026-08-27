const { reset } = require('../../src/models/db');
const RefreshTokenRepository = require('../../src/models/RefreshToken');

describe('RefreshTokenRepository', () => {
  beforeEach(() => reset());

  test('creates a token and returns the raw value once', () => {
    const { token, record } = RefreshTokenRepository.create({ tenantId: 't1', userId: 'u1' });

    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);
    expect(record.tenantId).toBe('t1');
    expect(record.userId).toBe('u1');
    expect(record.revoked).toBe(false);
  });

  test('throws when tenantId or userId is missing', () => {
    expect(() => RefreshTokenRepository.create({ userId: 'u1' })).toThrow(/required/);
    expect(() => RefreshTokenRepository.create({ tenantId: 't1' })).toThrow(/required/);
  });

  test('findValid returns the record for a freshly created token', () => {
    const { token } = RefreshTokenRepository.create({ tenantId: 't1', userId: 'u1' });
    const record = RefreshTokenRepository.findValid(token);

    expect(record).not.toBeNull();
    expect(record.userId).toBe('u1');
  });

  test('findValid returns null for an unknown token', () => {
    expect(RefreshTokenRepository.findValid('does-not-exist')).toBeNull();
  });

  test('findValid returns null for an expired token', () => {
    const { token } = RefreshTokenRepository.create({ tenantId: 't1', userId: 'u1', expiresIn: '-1s' });
    expect(RefreshTokenRepository.findValid(token)).toBeNull();
  });

  test('revoke marks a token invalid and returns true once', () => {
    const { token } = RefreshTokenRepository.create({ tenantId: 't1', userId: 'u1' });

    expect(RefreshTokenRepository.revoke(token)).toBe(true);
    expect(RefreshTokenRepository.findValid(token)).toBeNull();
    // Already revoked -- second call reports nothing new happened.
    expect(RefreshTokenRepository.revoke(token)).toBe(false);
  });

  test('revoke returns false for an unknown token', () => {
    expect(RefreshTokenRepository.revoke('ghost')).toBe(false);
  });

  test('revokeAllForUser revokes every active token for that user only', () => {
    const a = RefreshTokenRepository.create({ tenantId: 't1', userId: 'u1' });
    const b = RefreshTokenRepository.create({ tenantId: 't1', userId: 'u1' });
    const other = RefreshTokenRepository.create({ tenantId: 't1', userId: 'u2' });

    const count = RefreshTokenRepository.revokeAllForUser('t1', 'u1');

    expect(count).toBe(2);
    expect(RefreshTokenRepository.findValid(a.token)).toBeNull();
    expect(RefreshTokenRepository.findValid(b.token)).toBeNull();
    expect(RefreshTokenRepository.findValid(other.token)).not.toBeNull();
  });
});
