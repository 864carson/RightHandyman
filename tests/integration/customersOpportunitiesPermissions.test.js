require('../helpers/setup');
const request = require('supertest');
const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const UserRepository = require('../../src/models/User');
const CustomerRepository = require('../../src/models/Customer');
const OpportunityRepository = require('../../src/models/Opportunity');
const RolePermissions = require('../../src/models/RolePermissions');
const { PERMISSIONS } = require('../../src/config/permissions');
const { signToken } = require('../../src/utils/jwt');
const createApp = require('../../src/app');

const app = createApp();

describe('Customer routes', () => {
  let tenant;
  let owner;
  let admin;
  let member;
  let ownerToken;
  let adminToken;
  let memberToken;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme Inc', slug: 'acme' });
    owner = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-1', email: 'owner@example.com', role: 'owner' });
    admin = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-2', email: 'admin@example.com', role: 'admin' });
    member = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-3', email: 'member@example.com', role: 'member' });
    ownerToken = signToken({ userId: owner.id, tenantId: tenant.id });
    adminToken = signToken({ userId: admin.id, tenantId: tenant.id });
    memberToken = signToken({ userId: member.id, tenantId: tenant.id });
  });

  test('requires a tenant header and auth', async () => {
    const noTenant = await request(app).get('/customers').set('Authorization', `Bearer ${ownerToken}`);
    expect(noTenant.status).toBe(400);

    const noAuth = await request(app).get('/customers').set('x-tenant-id', 'acme');
    expect(noAuth.status).toBe(401);
  });

  test('POST /customers creates a customer (member has customers:create by default)', async () => {
    const res = await request(app)
      .post('/customers')
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ name: 'Wayne Enterprises', email: 'contact@wayne.com' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Wayne Enterprises');
    expect(res.body.tenantId).toBe(tenant.id);
    expect(res.body.createdBy).toBe(member.id);
  });

  test('POST /customers ignores a client-supplied tenantId (no cross-tenant injection)', async () => {
    const res = await request(app)
      .post('/customers')
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Wayne Enterprises', tenantId: 'some-other-tenant' });

    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBe(tenant.id);
  });

  test('POST /customers rejects a missing name', async () => {
    const res = await request(app)
      .post('/customers')
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});

    expect(res.status).toBe(400);
  });

  test('GET /customers lists tenant customers, GET /customers/:id fetches one', async () => {
    const created = CustomerRepository.create({ tenantId: tenant.id, name: 'Wayne Enterprises' });

    const list = await request(app).get('/customers').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    const single = await request(app).get(`/customers/${created.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`);
    expect(single.status).toBe(200);
    expect(single.body.id).toBe(created.id);
  });

  test('GET /customers/:id returns 404 for an unknown customer', async () => {
    const res = await request(app).get('/customers/ghost').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });

  test('PATCH /customers/:id updates fields (member has customers:update by default)', async () => {
    const created = CustomerRepository.create({ tenantId: tenant.id, name: 'Wayne Enterprises' });

    const res = await request(app)
      .patch(`/customers/${created.id}`)
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ phone: '555-1234' });

    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('555-1234');
  });

  test('DELETE /customers/:id is blocked for member by default', async () => {
    const created = CustomerRepository.create({ tenantId: tenant.id, name: 'Wayne Enterprises' });

    const res = await request(app)
      .delete(`/customers/${created.id}`)
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${memberToken}`);

    expect(res.status).toBe(403);
    expect(CustomerRepository.findById(tenant.id, created.id)).not.toBeNull();
  });

  test('DELETE /customers/:id works for admin and cascades to its opportunities', async () => {
    const created = CustomerRepository.create({ tenantId: tenant.id, name: 'Wayne Enterprises' });
    OpportunityRepository.create({ tenantId: tenant.id, customerId: created.id, name: 'Batmobile deal' });

    const res = await request(app)
      .delete(`/customers/${created.id}`)
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(204);
    expect(CustomerRepository.findById(tenant.id, created.id)).toBeNull();
    expect(OpportunityRepository.listByCustomer(tenant.id, created.id)).toHaveLength(0);
  });

  test('a tenant-level override can grant members delete access', async () => {
    RolePermissions.setOverride(tenant.id, 'member', [
      PERMISSIONS.CUSTOMERS_CREATE,
      PERMISSIONS.CUSTOMERS_READ,
      PERMISSIONS.CUSTOMERS_UPDATE,
      PERMISSIONS.CUSTOMERS_DELETE
    ]);
    const created = CustomerRepository.create({ tenantId: tenant.id, name: 'Wayne Enterprises' });

    const res = await request(app)
      .delete(`/customers/${created.id}`)
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${memberToken}`);

    expect(res.status).toBe(204);
  });

  test('GET /customers/:id/opportunities lists opportunities for that customer', async () => {
    const created = CustomerRepository.create({ tenantId: tenant.id, name: 'Wayne Enterprises' });
    OpportunityRepository.create({ tenantId: tenant.id, customerId: created.id, name: 'Deal 1' });
    OpportunityRepository.create({ tenantId: tenant.id, customerId: created.id, name: 'Deal 2' });

    const res = await request(app)
      .get(`/customers/${created.id}/opportunities`)
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${memberToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

describe('Opportunity routes', () => {
  let tenant;
  let owner;
  let member;
  let ownerToken;
  let memberToken;
  let customer;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme Inc', slug: 'acme' });
    owner = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-1', email: 'owner@example.com', role: 'owner' });
    member = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-2', email: 'member@example.com', role: 'member' });
    ownerToken = signToken({ userId: owner.id, tenantId: tenant.id });
    memberToken = signToken({ userId: member.id, tenantId: tenant.id });
    customer = CustomerRepository.create({ tenantId: tenant.id, name: 'Wayne Enterprises' });
  });

  test('POST /opportunities creates an opportunity tied to a customer', async () => {
    const res = await request(app)
      .post('/opportunities')
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ customerId: customer.id, name: 'Batmobile deal', amount: 250000, stage: 'qualified' });

    expect(res.status).toBe(201);
    expect(res.body.customerId).toBe(customer.id);
    expect(res.body.stage).toBe('qualified');
    expect(res.body.createdBy).toBe(member.id);
  });

  test('POST /opportunities rejects an unknown customerId', async () => {
    const res = await request(app)
      .post('/opportunities')
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ customerId: 'ghost-customer', name: 'Deal' });

    expect(res.status).toBe(400);
  });

  test('POST /opportunities rejects an invalid stage', async () => {
    const res = await request(app)
      .post('/opportunities')
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ customerId: customer.id, name: 'Deal', stage: 'bogus' });

    expect(res.status).toBe(400);
  });

  test('GET /opportunities?customerId= filters to one customer', async () => {
    const otherCustomer = CustomerRepository.create({ tenantId: tenant.id, name: 'Stark Industries' });
    OpportunityRepository.create({ tenantId: tenant.id, customerId: customer.id, name: 'Deal 1' });
    OpportunityRepository.create({ tenantId: tenant.id, customerId: otherCustomer.id, name: 'Deal 2' });

    const res = await request(app)
      .get(`/opportunities?customerId=${customer.id}`)
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${memberToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  test('PATCH /opportunities/:id updates stage/amount', async () => {
    const opp = OpportunityRepository.create({ tenantId: tenant.id, customerId: customer.id, name: 'Deal' });

    const res = await request(app)
      .patch(`/opportunities/${opp.id}`)
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ stage: 'won', amount: 99999 });

    expect(res.status).toBe(200);
    expect(res.body.stage).toBe('won');
    expect(res.body.amount).toBe(99999);
  });

  test('DELETE /opportunities/:id is blocked for member by default', async () => {
    const opp = OpportunityRepository.create({ tenantId: tenant.id, customerId: customer.id, name: 'Deal' });

    const res = await request(app)
      .delete(`/opportunities/${opp.id}`)
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${memberToken}`);

    expect(res.status).toBe(403);
  });

  test('DELETE /opportunities/:id works for owner', async () => {
    const opp = OpportunityRepository.create({ tenantId: tenant.id, customerId: customer.id, name: 'Deal' });

    const res = await request(app)
      .delete(`/opportunities/${opp.id}`)
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(204);
    expect(OpportunityRepository.findById(tenant.id, opp.id)).toBeNull();
  });
});

describe('Permission management routes', () => {
  let tenant;
  let owner;
  let admin;
  let ownerToken;
  let adminToken;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme Inc', slug: 'acme' });
    owner = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-1', email: 'owner@example.com', role: 'owner' });
    admin = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-2', email: 'admin@example.com', role: 'admin' });
    ownerToken = signToken({ userId: owner.id, tenantId: tenant.id });
    adminToken = signToken({ userId: admin.id, tenantId: tenant.id });
  });

  test('GET /tenants/:idOrSlug/role-permissions/catalog is available to any authenticated member', async () => {
    const res = await request(app).get('/tenants/acme/role-permissions/catalog').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.permissions).toContain(PERMISSIONS.CUSTOMERS_DELETE);
    expect(res.body.roles).toEqual(expect.arrayContaining(['owner', 'admin', 'member']));
  });

  test('GET /tenants/:idOrSlug/role-permissions returns the effective matrix, admin allowed', async () => {
    const res = await request(app).get('/tenants/acme/role-permissions').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.member).toBeDefined();
    expect(res.body.owner).toBeDefined();
  });

  test('PUT /tenants/:idOrSlug/role-permissions/:role rejects a non-owner', async () => {
    const res = await request(app)
      .put('/tenants/acme/role-permissions/member')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ permissions: [PERMISSIONS.CUSTOMERS_READ] });

    expect(res.status).toBe(403);
  });

  test('PUT /tenants/:idOrSlug/role-permissions/:role sets an override as owner', async () => {
    const res = await request(app)
      .put('/tenants/acme/role-permissions/member')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ permissions: [PERMISSIONS.CUSTOMERS_READ] });

    expect(res.status).toBe(200);
    expect(res.body.permissions).toEqual([PERMISSIONS.CUSTOMERS_READ]);
    expect(RolePermissions.getEffectivePermissions(tenant.id, 'member')).toEqual([PERMISSIONS.CUSTOMERS_READ]);
  });

  test('PUT rejects an unknown permission string', async () => {
    const res = await request(app)
      .put('/tenants/acme/role-permissions/member')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ permissions: ['not:a:real:permission'] });

    expect(res.status).toBe(400);
  });

  test('DELETE /tenants/:idOrSlug/role-permissions/:role reverts to defaults, owner only', async () => {
    RolePermissions.setOverride(tenant.id, 'member', [PERMISSIONS.CUSTOMERS_READ]);

    const forbidden = await request(app).delete('/tenants/acme/role-permissions/member').set('Authorization', `Bearer ${adminToken}`);
    expect(forbidden.status).toBe(403);

    const res = await request(app).delete('/tenants/acme/role-permissions/member').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.permissions.length).toBeGreaterThan(1);
  });

  test('GET /users/me/permissions reports the caller\'s effective permissions', async () => {
    const res = await request(app).get('/users/me/permissions').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
    expect(res.body.permissions).toContain(PERMISSIONS.CUSTOMERS_DELETE);
  });
});

describe('Tenant deletion cascades to customers and opportunities', () => {
  test('DELETE /tenants/:idOrSlug removes customers and opportunities too', async () => {
    reset();
    const tenant = TenantRepository.create({ name: 'Acme Inc', slug: 'acme' });
    const owner = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-1', email: 'owner@example.com', role: 'owner' });
    const ownerToken = signToken({ userId: owner.id, tenantId: tenant.id });
    const customer = CustomerRepository.create({ tenantId: tenant.id, name: 'Wayne Enterprises' });
    OpportunityRepository.create({ tenantId: tenant.id, customerId: customer.id, name: 'Deal' });

    const res = await request(app).delete('/tenants/acme').set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(204);
    expect(CustomerRepository.listByTenant(tenant.id)).toHaveLength(0);
    expect(OpportunityRepository.listByTenant(tenant.id)).toHaveLength(0);
  });
});
