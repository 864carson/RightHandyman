const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const tenantResolver = require('../../src/middleware/tenantResolver');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('tenantResolver middleware (header strategy)', () => {
  let tenant;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme Inc', slug: 'acme' });
  });

  test('attaches req.tenant when header matches a known slug', () => {
    const req = { headers: { 'x-tenant-id': 'acme' } };
    const res = mockRes();
    const next = jest.fn();

    tenantResolver({ strategy: 'header' })(req, res, next);

    expect(req.tenant).toEqual(tenant);
    expect(next).toHaveBeenCalled();
  });

  test('attaches req.tenant when header matches a known id', () => {
    const req = { headers: { 'x-tenant-id': tenant.id } };
    const res = mockRes();
    const next = jest.fn();

    tenantResolver({ strategy: 'header' })(req, res, next);

    expect(req.tenant).toEqual(tenant);
    expect(next).toHaveBeenCalled();
  });

  test('responds 400 when header is missing', () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();

    tenantResolver({ strategy: 'header' })(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  test('responds 404 when header does not match any tenant', () => {
    const req = { headers: { 'x-tenant-id': 'ghost' } };
    const res = mockRes();
    const next = jest.fn();

    tenantResolver({ strategy: 'header' })(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('tenantResolver middleware (subdomain strategy)', () => {
  let tenant;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme Inc', slug: 'acme' });
  });

  test('resolves tenant from subdomain', () => {
    const req = { headers: {}, hostname: 'acme.example.com' };
    const res = mockRes();
    const next = jest.fn();

    tenantResolver({ strategy: 'subdomain' })(req, res, next);

    expect(req.tenant).toEqual(tenant);
    expect(next).toHaveBeenCalled();
  });

  test('responds 400 for a bare domain with no subdomain', () => {
    const req = { headers: {}, hostname: 'example.com' };
    const res = mockRes();
    const next = jest.fn();

    tenantResolver({ strategy: 'subdomain' })(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});
