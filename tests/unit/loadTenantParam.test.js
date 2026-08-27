const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const loadTenantParam = require('../../src/middleware/loadTenantParam');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('loadTenantParam middleware', () => {
  let tenant;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme', slug: 'acme' });
  });

  test('resolves req.tenant from the slug param', () => {
    const req = { params: { idOrSlug: 'acme' } };
    const res = mockRes();
    const next = jest.fn();

    loadTenantParam()(req, res, next);

    expect(req.tenant).toEqual(tenant);
    expect(next).toHaveBeenCalled();
  });

  test('resolves req.tenant from the id param', () => {
    const req = { params: { idOrSlug: tenant.id } };
    const res = mockRes();
    const next = jest.fn();

    loadTenantParam()(req, res, next);

    expect(req.tenant).toEqual(tenant);
  });

  test('404s for an unknown tenant', () => {
    const req = { params: { idOrSlug: 'ghost' } };
    const res = mockRes();
    const next = jest.fn();

    loadTenantParam()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  test('supports a custom param name', () => {
    const req = { params: { tenantId: 'acme' } };
    const res = mockRes();
    const next = jest.fn();

    loadTenantParam('tenantId')(req, res, next);

    expect(req.tenant).toEqual(tenant);
  });
});
