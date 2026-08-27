require('../helpers/setup');
const { signToken, verifyToken } = require('../../src/utils/jwt');

describe('jwt utils', () => {
  test('signs and verifies a valid token round-trip', () => {
    const token = signToken({ userId: 'u1', tenantId: 't1' });
    const payload = verifyToken(token);

    expect(payload.userId).toBe('u1');
    expect(payload.tenantId).toBe('t1');
  });

  test('throws when signing without userId', () => {
    expect(() => signToken({ tenantId: 't1' })).toThrow(/tenantId and userId/);
  });

  test('throws when signing without tenantId', () => {
    expect(() => signToken({ userId: 'u1' })).toThrow(/tenantId and userId/);
  });

  test('throws when verifying a garbage token', () => {
    expect(() => verifyToken('not-a-real-token')).toThrow();
  });

  test('throws when verifying an expired token', () => {
    const token = signToken({ userId: 'u1', tenantId: 't1' }, { expiresIn: '-1s' });
    expect(() => verifyToken(token)).toThrow(/expired/i);
  });

  test('respects custom expiresIn option', () => {
    const token = signToken({ userId: 'u1', tenantId: 't1' }, { expiresIn: '10m' });
    const payload = verifyToken(token);
    const lifetimeSeconds = payload.exp - payload.iat;
    expect(lifetimeSeconds).toBe(600);
  });
});
