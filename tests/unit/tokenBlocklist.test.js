const { reset } = require('../../src/models/db');
const TokenBlocklist = require('../../src/models/TokenBlocklist');

describe('TokenBlocklist', () => {
  beforeEach(() => reset());

  test('a jti is not revoked by default', () => {
    expect(TokenBlocklist.isRevoked('some-jti')).toBe(false);
  });

  test('revoking a jti makes isRevoked true', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    TokenBlocklist.revoke('jti-1', future);

    expect(TokenBlocklist.isRevoked('jti-1')).toBe(true);
  });

  test('an expired blocklist entry is treated as not revoked', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    TokenBlocklist.revoke('jti-1', past);

    expect(TokenBlocklist.isRevoked('jti-1')).toBe(false);
  });

  test('revoke with no jti is a no-op', () => {
    expect(() => TokenBlocklist.revoke(undefined, new Date().toISOString())).not.toThrow();
  });

  test('isRevoked with no jti returns false', () => {
    expect(TokenBlocklist.isRevoked(undefined)).toBe(false);
  });
});
