const { hashToken } = require('../../src/utils/tokenHash');

describe('hashToken', () => {
  test('is deterministic for the same input', () => {
    expect(hashToken('abc123')).toBe(hashToken('abc123'));
  });

  test('different inputs produce different hashes', () => {
    expect(hashToken('abc123')).not.toBe(hashToken('abc124'));
  });

  test('produces a 64-character lowercase hex string (sha256)', () => {
    expect(hashToken('anything')).toMatch(/^[a-f0-9]{64}$/);
  });

  test('never returns the input unchanged', () => {
    expect(hashToken('plaintext-token')).not.toBe('plaintext-token');
  });
});
