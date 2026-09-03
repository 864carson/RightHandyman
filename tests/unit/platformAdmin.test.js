const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const UserRepository = require('../../src/models/User');
const AuditLogRepository = require('../../src/models/AuditLog');
const requirePlatformAdmin = require('../../src/middleware/requirePlatformAdmin');
const requirePermission = require('../../src/middleware/requirePermission');
const requireRole = require('../../src/middleware/requireRole');
const RolePermissions = require('../../src/models/RolePermissions');
const { redactCustomerPII, redactEstimateFinancials } = require('../../src/services/redaction');
const { PERMISSIONS } = require('../../src/config/permissions');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('User.platformAdmin / setPlatformAdmin', () => {
  let tenant;
  let user;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Ops', slug: 'ops' });
    user = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g1', email: 'support@ours.com' });
  });

  test('defaults to false and is never settable via the generic update()', () => {
    expect(user.platformAdmin).toBe(false);
    const updated = UserRepository.update(tenant.id, user.id, { platformAdmin: true });
    expect(updated.platformAdmin).toBe(false); // update() silently ignores unknown fields
  });

  test('setPlatformAdmin grants and revokes, tenant-scoped', () => {
    const granted = UserRepository.setPlatformAdmin(tenant.id, user.id, true);
    expect(granted.platformAdmin).toBe(true);

    const revoked = UserRepository.setPlatformAdmin(tenant.id, user.id, false);
    expect(revoked.platformAdmin).toBe(false);

    expect(UserRepository.setPlatformAdmin('other-tenant', user.id, true)).toBeNull();
  });
});

describe('AuditLogRepository', () => {
  let home;
  let target;
  let actor;

  beforeEach(() => {
    reset();
    home = TenantRepository.create({ name: 'Ops', slug: 'ops' });
    target = TenantRepository.create({ name: 'Acme', slug: 'acme' });
    actor = UserRepository.create({ tenantId: home.id, provider: 'google', providerId: 'g1', email: 'support@ours.com' });
  });

  test('records an entry and validates required fields/action', () => {
    const entry = AuditLogRepository.record({
      actorUserId: actor.id,
      actorHomeTenantId: home.id,
      targetTenantId: target.id,
      action: 'impersonation_start'
    });
    expect(entry.id).toBeDefined();

    expect(() => AuditLogRepository.record({ targetTenantId: target.id, action: 'impersonation_start' })).toThrow(/required/);
    expect(() => AuditLogRepository.record({ actorUserId: actor.id, targetTenantId: target.id, action: 'bogus' })).toThrow(
      /action must be one of/
    );
  });

  test('listForTargetTenant and listByActor scope correctly, newest first', () => {
    AuditLogRepository.record({ actorUserId: actor.id, targetTenantId: target.id, action: 'impersonation_start' });
    AuditLogRepository.record({ actorUserId: actor.id, targetTenantId: target.id, action: 'reveal_pii', resourceType: 'customer', resourceId: 'c1' });

    const forTarget = AuditLogRepository.listForTargetTenant(target.id);
    expect(forTarget).toHaveLength(2);
    expect(forTarget[0].createdAt >= forTarget[1].createdAt).toBe(true);

    expect(AuditLogRepository.listForTargetTenant(home.id)).toHaveLength(0);
    expect(AuditLogRepository.listByActor(actor.id)).toHaveLength(2);
  });
});

describe('redaction service', () => {
  test('redactCustomerPII hides email/phone by default, reveal shows them', () => {
    const customer = { id: 'c1', name: 'Jane', email: 'jane@example.com', phone: '555-1234' };
    const redacted = redactCustomerPII(customer);
    expect(redacted.email).toMatch(/hidden/);
    expect(redacted.phone).toMatch(/hidden/);
    expect(redacted.piiRedacted).toBe(true);
    expect(redacted.name).toBe('Jane'); // untouched

    const revealed = redactCustomerPII(customer, { reveal: true });
    expect(revealed.email).toBe('jane@example.com');
    expect(revealed.piiRedacted).toBe(false);
  });

  test('redactCustomerPII leaves a null email/phone as null, not a fake "hidden" string', () => {
    const redacted = redactCustomerPII({ id: 'c1', name: 'Jane', email: null, phone: null });
    expect(redacted.email).toBeNull();
    expect(redacted.phone).toBeNull();
  });

  test('redactEstimateFinancials strips cost/markup/margin but keeps price/tax/deposit', () => {
    const internalView = {
      id: 'e1',
      lineItems: [
        { id: 'li1', description: 'Mulch', unit: 'yard', quantity: 4, unitCost: 28, cost: 112, markupValue: 30, markupAmount: 33.6, price: 145.6, marginPercent: 23.08 }
      ],
      totals: {
        totalCost: 112,
        totalMarkup: 33.6,
        subtotalPrice: 145.6,
        taxRate: 0,
        taxAmount: 0,
        totalPrice: 145.6,
        marginPercent: 23.08,
        depositType: null,
        depositValue: null,
        deposit: 0,
        balanceDue: 145.6,
        byCategory: { materials: { cost: 112, markupAmount: 33.6, price: 145.6 } }
      }
    };

    const redacted = redactEstimateFinancials(internalView);
    expect(redacted.lineItems[0].cost).toBeUndefined();
    expect(redacted.lineItems[0].markupAmount).toBeUndefined();
    expect(redacted.lineItems[0].markupValue).toBeUndefined();
    expect(redacted.lineItems[0].unitCost).toBeUndefined();
    expect(redacted.lineItems[0].price).toBe(145.6);
    expect(redacted.totals.totalCost).toBeUndefined();
    expect(redacted.totals.totalMarkup).toBeUndefined();
    expect(redacted.totals.totalPrice).toBe(145.6);
    expect(redacted.totals.deposit).toBe(0);
    expect(redacted.totals.byCategory.materials).toEqual({ price: 145.6 });
    expect(redacted.financialsRedacted).toBe(true);

    const revealed = redactEstimateFinancials(internalView, { reveal: true });
    expect(revealed.lineItems[0].cost).toBe(112);
    expect(revealed.financialsRedacted).toBe(false);
  });
});

describe('requirePlatformAdmin middleware', () => {
  let home;
  let admin;
  let regular;

  beforeEach(() => {
    reset();
    home = TenantRepository.create({ name: 'Ops', slug: 'ops' });
    admin = UserRepository.create({ tenantId: home.id, provider: 'google', providerId: 'g1', email: 'admin@ours.com' });
    UserRepository.setPlatformAdmin(home.id, admin.id, true);
    regular = UserRepository.create({ tenantId: home.id, provider: 'google', providerId: 'g2', email: 'regular@ours.com' });
  });

  test('500s if req.user is missing', () => {
    const req = {};
    const res = mockRes();
    requirePlatformAdmin(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('401s if the token references a user that no longer exists', () => {
    const req = { user: { userId: 'ghost', tenantId: home.id } };
    const res = mockRes();
    requirePlatformAdmin(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('403s for a real user who is not a platform admin', () => {
    const req = { user: { userId: regular.id, tenantId: home.id } };
    const res = mockRes();
    requirePlatformAdmin(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('calls next for a real platform admin', () => {
    const req = { user: { userId: admin.id, tenantId: home.id } };
    const res = mockRes();
    const next = jest.fn();
    requirePlatformAdmin(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.currentUser.id).toBe(admin.id);
  });
});

describe('requirePermission / requireRole impersonation fallback', () => {
  let target;
  const impersonationUser = { userId: 'platform-admin-real-id', tenantId: 'home-tenant-id', impersonation: { active: true, actingRole: 'owner', homeTenantId: 'home-tenant-id' } };

  beforeEach(() => {
    reset();
    target = TenantRepository.create({ name: 'Acme', slug: 'acme' });
  });

  test('requirePermission grants owner-level access with no real membership row', () => {
    const req = { tenant: target, user: impersonationUser };
    const res = mockRes();
    const next = jest.fn();

    requirePermission(PERMISSIONS.CUSTOMERS_DELETE)(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.currentUser.impersonation).toBe(true);
    expect(req.currentUser.role).toBe('owner');
  });

  test('requirePermission respects a tenant override even while impersonating', () => {
    RolePermissions.setOverride(target.id, 'owner', [PERMISSIONS.CUSTOMERS_READ]);
    const req = { tenant: target, user: impersonationUser };
    const res = mockRes();

    requirePermission(PERMISSIONS.CUSTOMERS_DELETE)(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('real membership always wins over an impersonation claim on the same userId', () => {
    const UserRepository = require('../../src/models/User');
    const realMember = UserRepository.create({ tenantId: target.id, provider: 'google', providerId: 'g1', email: 'real@acme.com', role: 'member' });
    const req = { tenant: target, user: { ...impersonationUser, userId: realMember.id } };
    const res = mockRes();

    // member does not have customers:delete by default -- if impersonation
    // were (wrongly) taking priority, this would incorrectly succeed as 'owner'.
    requirePermission(PERMISSIONS.CUSTOMERS_DELETE)(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('401s when neither a real user nor a valid impersonation claim is present', () => {
    const req = { tenant: target, user: { userId: 'totally-unknown' } };
    const res = mockRes();

    requirePermission(PERMISSIONS.CUSTOMERS_READ)(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('requireRole allows an impersonated owner and rejects a mismatched acting role', () => {
    const allowedReq = { tenant: target, user: impersonationUser };
    const allowedRes = mockRes();
    const next = jest.fn();
    requireRole(['owner'])(allowedReq, allowedRes, next);
    expect(next).toHaveBeenCalled();

    const rejectedReq = { tenant: target, user: impersonationUser };
    const rejectedRes = mockRes();
    requireRole(['admin'])(rejectedReq, rejectedRes, jest.fn());
    expect(rejectedRes.status).toHaveBeenCalledWith(403);
  });
});
