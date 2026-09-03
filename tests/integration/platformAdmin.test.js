require('../helpers/setup');
const request = require('supertest');
const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const UserRepository = require('../../src/models/User');
const CustomerRepository = require('../../src/models/Customer');
const JobRepository = require('../../src/models/Job');
const EstimateRepository = require('../../src/models/Estimate');
const AuditLogRepository = require('../../src/models/AuditLog');
const { signToken } = require('../../src/utils/jwt');
const createApp = require('../../src/app');

const app = createApp();
const BOOTSTRAP_SECRET = 'test-bootstrap-secret';

describe('Platform admin: bootstrap grant + impersonation', () => {
  let home;
  let target;
  let supportAgent;
  let supportAgentToken;
  let targetCustomer;
  let targetJob;
  let targetEstimate;

  beforeEach(() => {
    reset();
    process.env.PLATFORM_ADMIN_BOOTSTRAP_SECRET = BOOTSTRAP_SECRET;

    home = TenantRepository.create({ name: 'Ops', slug: 'ops' });
    supportAgent = UserRepository.create({ tenantId: home.id, provider: 'google', providerId: 'g-support', email: 'support@ours.com' });
    supportAgentToken = signToken({ userId: supportAgent.id, tenantId: home.id });

    target = TenantRepository.create({ name: 'Acme Landscaping', slug: 'acme' });
    targetCustomer = CustomerRepository.create({ tenantId: target.id, name: 'Jane Homeowner', email: 'jane@example.com', phone: '555-1234' });
    targetJob = JobRepository.create({ tenantId: target.id, customerId: targetCustomer.id, title: 'Mulch bed refresh' });
    targetEstimate = EstimateRepository.create({
      tenantId: target.id,
      jobId: targetJob.id,
      lineItems: [{ description: 'Mulch', category: 'materials', unit: 'yard', quantity: 4, unitCost: 28, markupType: 'percent', markupValue: 30 }]
    });
  });

  afterEach(() => {
    delete process.env.PLATFORM_ADMIN_BOOTSTRAP_SECRET;
  });

  describe('POST /platform-admin/bootstrap-grant', () => {
    test('is disabled (503) when PLATFORM_ADMIN_BOOTSTRAP_SECRET is not set', async () => {
      delete process.env.PLATFORM_ADMIN_BOOTSTRAP_SECRET;
      const res = await request(app)
        .post('/platform-admin/bootstrap-grant')
        .send({ tenantId: home.id, userId: supportAgent.id });
      expect(res.status).toBe(503);
    });

    test('403s with a wrong secret', async () => {
      const res = await request(app)
        .post('/platform-admin/bootstrap-grant')
        .set('x-bootstrap-secret', 'not-the-right-secret')
        .send({ tenantId: home.id, userId: supportAgent.id });
      expect(res.status).toBe(403);
    });

    test('grants platformAdmin with the correct secret, and can revoke it', async () => {
      const grant = await request(app)
        .post('/platform-admin/bootstrap-grant')
        .set('x-bootstrap-secret', BOOTSTRAP_SECRET)
        .send({ tenantId: home.id, userId: supportAgent.id });
      expect(grant.status).toBe(200);
      expect(grant.body.platformAdmin).toBe(true);

      const revoke = await request(app)
        .post('/platform-admin/bootstrap-grant')
        .set('x-bootstrap-secret', BOOTSTRAP_SECRET)
        .send({ tenantId: home.id, userId: supportAgent.id, grant: false });
      expect(revoke.status).toBe(200);
      expect(revoke.body.platformAdmin).toBe(false);
    });

    test('404s for an unknown tenantId/userId pair', async () => {
      const res = await request(app)
        .post('/platform-admin/bootstrap-grant')
        .set('x-bootstrap-secret', BOOTSTRAP_SECRET)
        .send({ tenantId: home.id, userId: 'ghost' });
      expect(res.status).toBe(404);
    });
  });

  describe('platform-admin-only routes require the flag', () => {
    test('a non-platform-admin gets 403 from GET /platform-admin/tenants', async () => {
      const res = await request(app).get('/platform-admin/tenants').set('Authorization', `Bearer ${supportAgentToken}`);
      expect(res.status).toBe(403);
    });

    test('an unauthenticated request gets 401', async () => {
      const res = await request(app).get('/platform-admin/tenants');
      expect(res.status).toBe(401);
    });
  });

  describe('once granted: impersonation flow', () => {
    beforeEach(async () => {
      await request(app)
        .post('/platform-admin/bootstrap-grant')
        .set('x-bootstrap-secret', BOOTSTRAP_SECRET)
        .send({ tenantId: home.id, userId: supportAgent.id });
    });

    test('GET /platform-admin/tenants lists every tenant', async () => {
      const res = await request(app).get('/platform-admin/tenants').set('Authorization', `Bearer ${supportAgentToken}`);
      expect(res.status).toBe(200);
      expect(res.body.map((t) => t.id)).toEqual(expect.arrayContaining([home.id, target.id]));
    });

    test('POST /platform-admin/impersonate issues a token scoped to the target tenant and logs it', async () => {
      const res = await request(app)
        .post('/platform-admin/impersonate')
        .set('Authorization', `Bearer ${supportAgentToken}`)
        .send({ tenantId: target.id, reason: 'customer support ticket #4321' });

      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.actingRole).toBe('owner');
      expect(res.body.tenant.id).toBe(target.id);
      expect(res.body.refreshToken).toBeUndefined(); // non-refreshable by design

      const log = AuditLogRepository.listForTargetTenant(target.id);
      expect(log).toHaveLength(1);
      expect(log[0].action).toBe('impersonation_start');
      expect(log[0].reason).toBe('customer support ticket #4321');
      expect(log[0].actorUserId).toBe(supportAgent.id);
    });

    test('resolves the target by tenantSlug too', async () => {
      const res = await request(app)
        .post('/platform-admin/impersonate')
        .set('Authorization', `Bearer ${supportAgentToken}`)
        .send({ tenantSlug: 'acme' });
      expect(res.status).toBe(200);
      expect(res.body.tenant.id).toBe(target.id);
    });

    test('404s for an unknown target tenant', async () => {
      const res = await request(app)
        .post('/platform-admin/impersonate')
        .set('Authorization', `Bearer ${supportAgentToken}`)
        .send({ tenantId: 'ghost-tenant' });
      expect(res.status).toBe(404);
    });

    test('400s with neither tenantId nor tenantSlug', async () => {
      const res = await request(app).post('/platform-admin/impersonate').set('Authorization', `Bearer ${supportAgentToken}`).send({});
      expect(res.status).toBe(400);
    });

    describe('using the impersonation token against the target tenant', () => {
      let impersonationToken;

      beforeEach(async () => {
        const res = await request(app)
          .post('/platform-admin/impersonate')
          .set('Authorization', `Bearer ${supportAgentToken}`)
          .send({ tenantId: target.id });
        impersonationToken = res.body.accessToken;
      });

      test('can read and act on data in a tenant they were never a member of', async () => {
        const listCustomers = await request(app).get('/customers').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${impersonationToken}`);
        expect(listCustomers.status).toBe(200);
        expect(listCustomers.body).toHaveLength(1);

        // full read+write: can approve an estimate in a tenant they don't belong to
        const approve = await request(app)
          .post(`/estimates/${targetEstimate.id}/approve`)
          .set('x-tenant-id', 'acme')
          .set('Authorization', `Bearer ${impersonationToken}`)
          .send({ approvedByName: 'Support Agent (on behalf of customer)' });
        expect(approve.status).toBe(200);
        expect(approve.body.status).toBe('approved');
      });

      test('does NOT appear in the target tenant member list', async () => {
        const members = await request(app).get('/users').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${impersonationToken}`);
        expect(members.body.find((u) => u.id === supportAgent.id)).toBeUndefined();
      });

      test('customer PII is redacted by default, and revealed (+ audit logged) with ?reveal=true', async () => {
        const redacted = await request(app)
          .get(`/customers/${targetCustomer.id}`)
          .set('x-tenant-id', 'acme')
          .set('Authorization', `Bearer ${impersonationToken}`);
        expect(redacted.status).toBe(200);
        expect(redacted.body.email).toMatch(/hidden/);
        expect(redacted.body.piiRedacted).toBe(true);

        const revealed = await request(app)
          .get(`/customers/${targetCustomer.id}?reveal=true`)
          .set('x-tenant-id', 'acme')
          .set('Authorization', `Bearer ${impersonationToken}`);
        expect(revealed.status).toBe(200);
        expect(revealed.body.email).toBe('jane@example.com');

        const log = AuditLogRepository.listForTargetTenant(target.id).filter((e) => e.action === 'reveal_pii');
        expect(log).toHaveLength(1);
        expect(log[0].resourceId).toBe(targetCustomer.id);
      });

      test('estimate cost/markup/margin are redacted by default, revealed with ?reveal=true', async () => {
        const redacted = await request(app)
          .get(`/estimates/${targetEstimate.id}`)
          .set('x-tenant-id', 'acme')
          .set('Authorization', `Bearer ${impersonationToken}`);
        expect(redacted.status).toBe(200);
        expect(redacted.body.lineItems[0].cost).toBeUndefined();
        expect(redacted.body.financialsRedacted).toBe(true);
        expect(redacted.body.totals.totalPrice).toBeGreaterThan(0); // price still visible

        const revealed = await request(app)
          .get(`/estimates/${targetEstimate.id}?reveal=true`)
          .set('x-tenant-id', 'acme')
          .set('Authorization', `Bearer ${impersonationToken}`);
        expect(revealed.body.lineItems[0].cost).toBeDefined();

        const log = AuditLogRepository.listForTargetTenant(target.id).filter((e) => e.action === 'reveal_financials');
        expect(log).toHaveLength(1);
      });

      test('a write-action response (approve) is ALSO redacted by default, not just GETs', async () => {
        const res = await request(app)
          .post(`/estimates/${targetEstimate.id}/approve`)
          .set('x-tenant-id', 'acme')
          .set('Authorization', `Bearer ${impersonationToken}`)
          .send({});
        expect(res.body.lineItems[0].cost).toBeUndefined();
        expect(res.body.financialsRedacted).toBe(true);
      });

      test('a real tenant member is never affected by redaction', async () => {
        const realOwnerToken = signToken({
          userId: UserRepository.create({ tenantId: target.id, provider: 'google', providerId: 'g-real', email: 'owner@acme.com', role: 'owner' }).id,
          tenantId: target.id
        });

        const res = await request(app).get(`/customers/${targetCustomer.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${realOwnerToken}`);
        expect(res.body.email).toBe('jane@example.com');
        expect(res.body.piiRedacted).toBeUndefined();
      });

      test('token is scoped to the target tenant only -- rejected against a different tenant header', async () => {
        const otherTenant = TenantRepository.create({ name: 'Other Co', slug: 'other-co' });
        const res = await request(app).get('/customers').set('x-tenant-id', 'other-co').set('Authorization', `Bearer ${impersonationToken}`);
        expect(res.status).toBe(403); // token does not belong to this tenant
      });
    });
  });

  describe('GET /tenants/:idOrSlug/impersonation-log', () => {
    test('lets the target tenant\'s owner see when platform staff accessed their account', async () => {
      await request(app)
        .post('/platform-admin/bootstrap-grant')
        .set('x-bootstrap-secret', BOOTSTRAP_SECRET)
        .send({ tenantId: home.id, userId: supportAgent.id });
      await request(app).post('/platform-admin/impersonate').set('Authorization', `Bearer ${supportAgentToken}`).send({ tenantId: target.id });

      const targetOwner = UserRepository.create({ tenantId: target.id, provider: 'google', providerId: 'g-owner', email: 'owner@acme.com', role: 'owner' });
      const targetOwnerToken = signToken({ userId: targetOwner.id, tenantId: target.id });

      const res = await request(app).get('/tenants/acme/impersonation-log').set('Authorization', `Bearer ${targetOwnerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].action).toBe('impersonation_start');
    });

    test('is owner-only -- a member of the target tenant gets 403', async () => {
      const targetMember = UserRepository.create({ tenantId: target.id, provider: 'google', providerId: 'g-mem', email: 'member@acme.com', role: 'member' });
      const targetMemberToken = signToken({ userId: targetMember.id, tenantId: target.id });

      const res = await request(app).get('/tenants/acme/impersonation-log').set('Authorization', `Bearer ${targetMemberToken}`);
      expect(res.status).toBe(403);
    });
  });
});
