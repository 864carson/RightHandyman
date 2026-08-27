require('../helpers/setup');
const request = require('supertest');
const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const UserRepository = require('../../src/models/User');
const RefreshTokenRepository = require('../../src/models/RefreshToken');
const { signToken, verifyToken } = require('../../src/utils/jwt');
const createApp = require('../../src/app');

const app = createApp();

describe('GET /health', () => {
  test('returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('Tenant routes', () => {
  beforeEach(() => reset());

  test('POST /tenants creates a tenant', async () => {
    const res = await request(app).post('/tenants').send({ name: 'Acme Inc', slug: 'acme' });

    expect(res.status).toBe(201);
    expect(res.body.slug).toBe('acme');
  });

  test('POST /tenants rejects duplicate slug', async () => {
    await request(app).post('/tenants').send({ name: 'Acme Inc', slug: 'acme' });
    const res = await request(app).post('/tenants').send({ name: 'Acme 2', slug: 'acme' });

    expect(res.status).toBe(400);
  });

  test('GET /tenants/:idOrSlug returns 404 for unknown tenant', async () => {
    const res = await request(app).get('/tenants/ghost');
    expect(res.status).toBe(404);
  });

  test('GET /tenants/:idOrSlug finds by slug', async () => {
    await request(app).post('/tenants').send({ name: 'Acme Inc', slug: 'acme' });
    const res = await request(app).get('/tenants/acme');

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Acme Inc');
  });
});

describe('User routes (tenant + auth protected)', () => {
  let tenant;
  let user;
  let token;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme Inc', slug: 'acme' });
    user = UserRepository.create({
      tenantId: tenant.id,
      provider: 'google',
      providerId: 'g-1',
      email: 'jane@example.com',
      displayName: 'Jane Doe'
    });
    token = signToken({ userId: user.id, tenantId: tenant.id, email: user.email });
  });

  test('rejects request with no tenant header', async () => {
    const res = await request(app).get('/users/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  test('rejects request with no auth token', async () => {
    const res = await request(app).get('/users/me').set('x-tenant-id', 'acme');
    expect(res.status).toBe(401);
  });

  test('rejects a token minted for a different tenant', async () => {
    const otherTenant = TenantRepository.create({ name: 'Other Co', slug: 'other' });
    const otherToken = signToken({ userId: user.id, tenantId: otherTenant.id });

    const res = await request(app)
      .get('/users/me')
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
  });

  test('returns the current user with a valid tenant + token', async () => {
    const res = await request(app)
      .get('/users/me')
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.id);
    expect(res.body.email).toBe('jane@example.com');
  });

  test('lists users scoped to the tenant', async () => {
    const res = await request(app)
      .get('/users')
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  test('PATCH /users/:id lets a user update their own displayName', async () => {
    const res = await request(app)
      .patch(`/users/${user.id}`)
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${token}`)
      .send({ displayName: 'Jane Renamed' });

    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('Jane Renamed');
  });

  test('PATCH /users/:id blocks a member from changing their own role', async () => {
    const res = await request(app)
      .patch(`/users/${user.id}`)
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'admin' });

    expect(res.status).toBe(403);
  });

  test('PATCH /users/:id blocks a member from editing someone else', async () => {
    const other = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-2', email: 'bob@example.com' });

    const res = await request(app)
      .patch(`/users/${other.id}`)
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${token}`)
      .send({ displayName: 'Hacked' });

    expect(res.status).toBe(403);
  });

  test('PATCH /users/:id allows an admin to change another member\'s role', async () => {
    UserRepository.update(tenant.id, user.id, { role: 'admin' });
    const other = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-2', email: 'bob@example.com' });

    const res = await request(app)
      .patch(`/users/${other.id}`)
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'admin' });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
  });

  test('DELETE /users/:id lets a user delete their own account', async () => {
    const res = await request(app)
      .delete(`/users/${user.id}`)
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(UserRepository.findById(tenant.id, user.id)).toBeNull();
  });

  test('DELETE /users/:id blocks a member from deleting someone else', async () => {
    const other = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-2', email: 'bob@example.com' });

    const res = await request(app)
      .delete(`/users/${other.id}`)
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(UserRepository.findById(tenant.id, other.id)).not.toBeNull();
  });

  test('DELETE /users/:id returns 404 for an unknown user', async () => {
    const res = await request(app)
      .delete('/users/ghost-id')
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

describe('Tenant management routes (PATCH/DELETE, ownership-gated)', () => {
  let tenant;
  let owner;
  let ownerToken;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme Inc', slug: 'acme' });
    owner = UserRepository.create({
      tenantId: tenant.id,
      provider: 'google',
      providerId: 'g-1',
      email: 'owner@example.com',
      role: 'owner'
    });
    ownerToken = signToken({ userId: owner.id, tenantId: tenant.id });
  });

  test('PATCH /tenants/:idOrSlug requires auth', async () => {
    const res = await request(app).patch('/tenants/acme').send({ name: 'New Name' });
    expect(res.status).toBe(401);
  });

  test('PATCH /tenants/:idOrSlug rejects a non-owner/admin', async () => {
    const member = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-2', email: 'member@example.com' });
    const memberToken = signToken({ userId: member.id, tenantId: tenant.id });

    const res = await request(app)
      .patch('/tenants/acme')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ name: 'New Name' });

    expect(res.status).toBe(403);
  });

  test('PATCH /tenants/:idOrSlug lets an owner rename the tenant', async () => {
    const res = await request(app)
      .patch('/tenants/acme')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Acme Corporation' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Acme Corporation');
  });

  test('DELETE /tenants/:idOrSlug rejects a non-owner', async () => {
    const admin = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-3', email: 'admin@example.com', role: 'admin' });
    const adminToken = signToken({ userId: admin.id, tenantId: tenant.id });

    const res = await request(app).delete('/tenants/acme').set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(403);
  });

  test('DELETE /tenants/:idOrSlug removes the tenant and all its members', async () => {
    const res = await request(app).delete('/tenants/acme').set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(204);
    expect(TenantRepository.findBySlug('acme')).toBeNull();
    expect(UserRepository.findById(tenant.id, owner.id)).toBeNull();
  });
});

describe('Tenant membership routes (invite/remove)', () => {
  let tenant;
  let owner;
  let ownerToken;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme Inc', slug: 'acme' });
    owner = UserRepository.create({
      tenantId: tenant.id,
      provider: 'google',
      providerId: 'g-1',
      email: 'owner@example.com',
      role: 'owner'
    });
    ownerToken = signToken({ userId: owner.id, tenantId: tenant.id });
  });

  test('GET /tenants/:idOrSlug/members lists members', async () => {
    const res = await request(app).get('/tenants/acme/members').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  test('POST /tenants/:idOrSlug/members/invite creates a pending member', async () => {
    const res = await request(app)
      .post('/tenants/acme/members/invite')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'newperson@example.com', role: 'member' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('invited');
  });

  test('POST /tenants/:idOrSlug/members/invite rejects a non-admin', async () => {
    const member = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-2', email: 'member@example.com' });
    const memberToken = signToken({ userId: member.id, tenantId: tenant.id });

    const res = await request(app)
      .post('/tenants/acme/members/invite')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ email: 'newperson@example.com' });

    expect(res.status).toBe(403);
  });

  test('POST /tenants/:idOrSlug/members/invite rejects a duplicate email', async () => {
    await request(app)
      .post('/tenants/acme/members/invite')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'dup@example.com' });

    const res = await request(app)
      .post('/tenants/acme/members/invite')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'dup@example.com' });

    expect(res.status).toBe(409);
  });

  test('DELETE /tenants/:idOrSlug/members/:userId removes a member', async () => {
    const member = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-2', email: 'member@example.com' });

    const res = await request(app)
      .delete(`/tenants/acme/members/${member.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(204);
    expect(UserRepository.findById(tenant.id, member.id)).toBeNull();
  });

  test('DELETE /tenants/:idOrSlug/members/:userId blocks an admin from removing an owner', async () => {
    const admin = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-3', email: 'admin@example.com', role: 'admin' });
    const adminToken = signToken({ userId: admin.id, tenantId: tenant.id });

    const res = await request(app)
      .delete(`/tenants/acme/members/${owner.id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(403);
    expect(UserRepository.findById(tenant.id, owner.id)).not.toBeNull();
  });

  test('an invited member can later log in and get linked (simulated via findOrCreateUser)', async () => {
    const inviteRes = await request(app)
      .post('/tenants/acme/members/invite')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'invitee@example.com', role: 'admin' });

    const { findOrCreateUser } = require('../../src/controllers/authController');
    const activated = findOrCreateUser({
      tenantId: tenant.id,
      provider: 'github',
      providerId: 'gh-1',
      email: 'invitee@example.com'
    });

    expect(activated.id).toBe(inviteRes.body.id);
    expect(activated.status).toBe('active');
    expect(activated.role).toBe('admin');
  });
});

describe('Auth session routes (refresh/logout)', () => {
  let tenant;
  let user;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme Inc', slug: 'acme' });
    user = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-1', email: 'jane@example.com' });
  });

  test('POST /auth/refresh returns a new pair for a valid refresh token', async () => {
    const { token: refreshToken } = RefreshTokenRepository.create({ tenantId: tenant.id, userId: user.id });

    const res = await request(app).post('/auth/refresh').send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).not.toBe(refreshToken);
  });

  test('POST /auth/refresh rejects a missing refresh token', async () => {
    const res = await request(app).post('/auth/refresh').send({});
    expect(res.status).toBe(400);
  });

  test('POST /auth/refresh rejects an invalid refresh token', async () => {
    const res = await request(app).post('/auth/refresh').send({ refreshToken: 'garbage' });
    expect(res.status).toBe(401);
  });

  test('POST /auth/refresh rejects a reused (already rotated) refresh token', async () => {
    const { token: refreshToken } = RefreshTokenRepository.create({ tenantId: tenant.id, userId: user.id });
    await request(app).post('/auth/refresh').send({ refreshToken });

    const res = await request(app).post('/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
  });

  test('POST /auth/logout requires auth', async () => {
    const res = await request(app).post('/auth/logout').send({});
    expect(res.status).toBe(401);
  });

  test('POST /auth/logout revokes the refresh token and blocklists the access token', async () => {
    const accessToken = signToken({ userId: user.id, tenantId: tenant.id });
    const { token: refreshToken } = RefreshTokenRepository.create({ tenantId: tenant.id, userId: user.id });

    const logoutRes = await request(app)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken });

    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.revokedRefreshTokens).toBe(1);

    // The access token itself is now blocklisted -- any protected route rejects it.
    const meRes = await request(app)
      .get('/users/me')
      .set('x-tenant-id', 'acme')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(meRes.status).toBe(401);

    // The refresh token is revoked too.
    const refreshRes = await request(app).post('/auth/refresh').send({ refreshToken });
    expect(refreshRes.status).toBe(401);
  });
});

describe('Auth routes', () => {
  beforeEach(() => reset());

  test('GET /auth/:provider without ?tenant returns 400', async () => {
    const res = await request(app).get('/auth/google');
    expect(res.status).toBe(400);
  });

  test('GET /auth/:provider with unknown tenant returns 400', async () => {
    const res = await request(app).get('/auth/google?tenant=ghost');
    expect(res.status).toBe(400);
  });

  test('GET /auth/:provider for unsupported provider returns 404', async () => {
    await request(app).post('/tenants').send({ name: 'Acme Inc', slug: 'acme' });
    const res = await request(app).get('/auth/facebook?tenant=acme');
    expect(res.status).toBe(404);
  });
});
