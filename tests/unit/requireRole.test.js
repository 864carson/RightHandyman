const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const UserRepository = require('../../src/models/User');
const requireRole = require('../../src/middleware/requireRole');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('requireRole middleware', () => {
  let tenant;
  let owner;
  let member;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme', slug: 'acme' });
    owner = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-1', email: 'owner@example.com', role: 'owner' });
    member = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-2', email: 'member@example.com', role: 'member' });
  });

  test('500s if req.tenant or req.user is missing (misconfiguration)', () => {
    const req = { user: { userId: owner.id } };
    const res = mockRes();
    const next = jest.fn();

    requireRole(['owner'])(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });

  test('401s if the user no longer exists', () => {
    const req = { tenant, user: { userId: 'ghost' } };
    const res = mockRes();
    const next = jest.fn();

    requireRole(['owner'])(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('403s when the user role is not in the allowed list', () => {
    const req = { tenant, user: { userId: member.id } };
    const res = mockRes();
    const next = jest.fn();

    requireRole(['owner', 'admin'])(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next and attaches req.currentUser when role matches', () => {
    const req = { tenant, user: { userId: owner.id } };
    const res = mockRes();
    const next = jest.fn();

    requireRole(['owner', 'admin'])(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.currentUser.id).toBe(owner.id);
  });

  test('uses fresh role from the repository, not the JWT payload', () => {
    // Payload claims 'owner' but the actual stored role is 'member' --
    // the middleware should trust the repository, not the token.
    UserRepository.update(tenant.id, member.id, { role: 'member' });
    const req = { tenant, user: { userId: member.id, role: 'owner' } };
    const res = mockRes();
    const next = jest.fn();

    requireRole(['owner'])(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});
