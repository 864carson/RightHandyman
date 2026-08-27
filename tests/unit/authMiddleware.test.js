require('../helpers/setup');
const { requireAuth } = require('../../src/middleware/auth');
const { signToken } = require('../../src/utils/jwt');
const { reset } = require('../../src/models/db');
const TokenBlocklist = require('../../src/models/TokenBlocklist');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('requireAuth middleware', () => {
  test('rejects when Authorization header is missing', () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects a malformed Authorization header', () => {
    const req = { headers: { authorization: 'Token abc' } };
    const res = mockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects an invalid token', () => {
    const req = { headers: { authorization: 'Bearer not-a-real-token' } };
    const res = mockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('attaches req.user and calls next for a valid token', () => {
    const token = signToken({ userId: 'u1', tenantId: 't1' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(req.user.userId).toBe('u1');
    expect(next).toHaveBeenCalled();
  });

  test('rejects when token tenantId does not match req.tenant', () => {
    const token = signToken({ userId: 'u1', tenantId: 't1' });
    const req = { headers: { authorization: `Bearer ${token}` }, tenant: { id: 't2' } };
    const res = mockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('allows when token tenantId matches req.tenant', () => {
    const token = signToken({ userId: 'u1', tenantId: 't1' });
    const req = { headers: { authorization: `Bearer ${token}` }, tenant: { id: 't1' } };
    const res = mockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('rejects a token whose jti has been revoked (logged out)', () => {
    reset();
    const token = signToken({ userId: 'u1', tenantId: 't1' });
    const { jti } = require('../../src/utils/jwt').verifyToken(token);
    TokenBlocklist.revoke(jti, new Date(Date.now() + 60_000).toISOString());

    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
