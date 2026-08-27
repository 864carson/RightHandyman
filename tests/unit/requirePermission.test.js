const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const UserRepository = require('../../src/models/User');
const RolePermissions = require('../../src/models/RolePermissions');
const requirePermission = require('../../src/middleware/requirePermission');
const { PERMISSIONS } = require('../../src/config/permissions');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('requirePermission middleware', () => {
  let tenant;
  let admin;
  let member;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme', slug: 'acme' });
    admin = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-1', email: 'admin@example.com', role: 'admin' });
    member = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-2', email: 'member@example.com', role: 'member' });
  });

  test('500s if req.tenant or req.user is missing', () => {
    const req = { user: { userId: admin.id } };
    const res = mockRes();
    const next = jest.fn();

    requirePermission(PERMISSIONS.CUSTOMERS_DELETE)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('401s if the user no longer exists', () => {
    const req = { tenant, user: { userId: 'ghost' } };
    const res = mockRes();
    const next = jest.fn();

    requirePermission(PERMISSIONS.CUSTOMERS_READ)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('403s when the role\'s default permissions do not include the required one', () => {
    // member has no customers:delete by default
    const req = { tenant, user: { userId: member.id } };
    const res = mockRes();
    const next = jest.fn();

    requirePermission(PERMISSIONS.CUSTOMERS_DELETE)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next when the role has the permission by default', () => {
    // admin has customers:delete by default
    const req = { tenant, user: { userId: admin.id } };
    const res = mockRes();
    const next = jest.fn();

    requirePermission(PERMISSIONS.CUSTOMERS_DELETE)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.currentUser.id).toBe(admin.id);
  });

  test('respects a tenant-level permission override', () => {
    // Tenant grants members customers:delete, overriding the default.
    RolePermissions.setOverride(tenant.id, 'member', [PERMISSIONS.CUSTOMERS_DELETE]);

    const req = { tenant, user: { userId: member.id } };
    const res = mockRes();
    const next = jest.fn();

    requirePermission(PERMISSIONS.CUSTOMERS_DELETE)(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('an override can also narrow a role below its default', () => {
    // Tenant strips admin's customers:delete permission.
    RolePermissions.setOverride(tenant.id, 'admin', [PERMISSIONS.CUSTOMERS_READ]);

    const req = { tenant, user: { userId: admin.id } };
    const res = mockRes();
    const next = jest.fn();

    requirePermission(PERMISSIONS.CUSTOMERS_DELETE)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});
