require('../helpers/setup');
const request = require('supertest');
const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const UserRepository = require('../../src/models/User');
const CustomerRepository = require('../../src/models/Customer');
const JobRepository = require('../../src/models/Job');
const MessageRepository = require('../../src/models/Message');
const { resetSmsProvider, getSmsProvider } = require('../../src/services/sms');
const { signToken } = require('../../src/utils/jwt');
const createApp = require('../../src/app');

const app = createApp();

describe('Messaging routes', () => {
  let tenant;
  let owner;
  let ownerToken;
  let member;
  let memberToken;
  let customer;
  let job;

  beforeEach(() => {
    reset();
    process.env.SMS_PROVIDER = 'console';
    process.env.SMS_FROM_NUMBER = '+15559998888';
    resetSmsProvider();
    getSmsProvider().reset();

    tenant = TenantRepository.create({ name: 'Acme Landscaping', slug: 'acme' });
    owner = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-owner', email: 'owner@example.com', role: 'owner' });
    member = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-mem', email: 'crew@example.com', role: 'member' });
    ownerToken = signToken({ userId: owner.id, tenantId: tenant.id });
    memberToken = signToken({ userId: member.id, tenantId: tenant.id });
    customer = CustomerRepository.create({ tenantId: tenant.id, name: 'Jane Homeowner', phone: '+15551234567' });
    job = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'Mulch bed refresh' });
  });

  afterEach(() => {
    delete process.env.SMS_PROVIDER;
    delete process.env.SMS_FROM_NUMBER;
    resetSmsProvider();
  });

  describe('POST /messages', () => {
    test('a member can send a message (messages:send is granted by default)', async () => {
      const res = await request(app)
        .post('/messages')
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ customerId: customer.id, jobId: job.id, body: 'Your estimate is ready!' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('sent');
      expect(res.body.provider).toBe('console');
    });

    test('400 when body is missing', async () => {
      const res = await request(app).post('/messages').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({ customerId: customer.id });
      expect(res.status).toBe(400);
    });

    test('404 for an unknown customer', async () => {
      const res = await request(app).post('/messages').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({ customerId: 'ghost', body: 'hi' });
      expect(res.status).toBe(404);
    });

    test('400 when the customer has no phone on file', async () => {
      const noPhone = CustomerRepository.create({ tenantId: tenant.id, name: 'No Phone' });
      const res = await request(app).post('/messages').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({ customerId: noPhone.id, body: 'hi' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /messages, GET /customers/:id/messages, GET /jobs/:id/messages', () => {
    beforeEach(async () => {
      await request(app).post('/messages').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({ customerId: customer.id, jobId: job.id, body: 'Job-specific message' });
      await request(app).post('/messages').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({ customerId: customer.id, body: 'Customer-wide message' });
    });

    test('GET /messages lists everything for the tenant', async () => {
      const res = await request(app).get('/messages').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    test('GET /messages?jobId= filters to that job', async () => {
      const res = await request(app).get(`/messages?jobId=${job.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].body).toBe('Job-specific message');
    });

    test('GET /customers/:id/messages returns every message for that customer, job-scoped or not', async () => {
      const res = await request(app).get(`/customers/${customer.id}/messages`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    test('GET /jobs/:id/messages returns only messages tied to that job', async () => {
      const res = await request(app).get(`/jobs/${job.id}/messages`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });
  });

  describe('Webhooks (unauthenticated)', () => {
    test('POST /webhooks/sms/console/inbound records and matches an inbound message, no auth required', async () => {
      const res = await request(app).post('/webhooks/sms/console/inbound').send({ from: '+15551234567', to: '+15559998888', text: 'Sounds good!' });
      expect(res.status).toBe(200);

      const messages = MessageRepository.listByCustomer(tenant.id, customer.id);
      expect(messages).toHaveLength(1);
      expect(messages[0].matchStatus).toBe('matched');
      expect(messages[0].body).toBe('Sounds good!');
    });

    test('unmatched inbound message is stored without a tenant, no auth required', async () => {
      const res = await request(app).post('/webhooks/sms/console/inbound').send({ from: '+19995550000', to: '+15559998888', text: 'Who is this' });
      expect(res.status).toBe(200);
      expect(MessageRepository.listUnmatched()).toHaveLength(1);
    });

    test('POST /webhooks/sms/:provider/status updates the matching message', async () => {
      const sendRes = await request(app).post('/messages').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({ customerId: customer.id, body: 'hi' });

      const statusRes = await request(app).post('/webhooks/sms/console/status').send({ messageId: sendRes.body.providerMessageId, status: 'delivered' });
      expect(statusRes.status).toBe(200);

      const updated = MessageRepository.findById(tenant.id, sendRes.body.id);
      expect(updated.status).toBe('delivered');
    });

    test('400 for an unknown provider name in the URL', async () => {
      const res = await request(app).post('/webhooks/sms/not_a_real_provider/inbound').send({});
      expect(res.status).toBe(400);
    });

    test('unverified webhooks are still processed by default (SMS_WEBHOOK_STRICT_VERIFICATION unset)', async () => {
      // Twilio's adapter returns verified:false when there's no signature
      // header, without ever needing the twilio SDK installed (the check
      // happens before touching it) -- a genuine test of the "unverified
      // but non-strict" path, unlike console which always verifies true.
      const res = await request(app)
        .post('/webhooks/sms/twilio/inbound')
        .type('form')
        .send({ From: '+15551234567', To: '+15559998888', Body: 'test', MessageSid: 'SM123' });
      expect(res.status).toBe(200);
    });

    test('strict mode (SMS_WEBHOOK_STRICT_VERIFICATION=true) rejects an unverified webhook', async () => {
      process.env.SMS_WEBHOOK_STRICT_VERIFICATION = 'true';
      const res = await request(app)
        .post('/webhooks/sms/twilio/inbound')
        .type('form')
        .send({ From: '+15551234567', To: '+15559998888', Body: 'test', MessageSid: 'SM123' });
      expect(res.status).toBe(401);
      delete process.env.SMS_WEBHOOK_STRICT_VERIFICATION;
    });
  });

  describe('Redaction during impersonation', () => {
    let homeTenant;
    let supportAgentToken;
    let impersonationToken;

    beforeEach(async () => {
      process.env.PLATFORM_ADMIN_BOOTSTRAP_SECRET = 'test-secret';
      homeTenant = TenantRepository.create({ name: 'Ops', slug: 'ops' });
      const supportAgent = UserRepository.create({ tenantId: homeTenant.id, provider: 'google', providerId: 'g-support', email: 'support@ours.com' });
      supportAgentToken = signToken({ userId: supportAgent.id, tenantId: homeTenant.id });

      await request(app).post('/platform-admin/bootstrap-grant').set('x-bootstrap-secret', 'test-secret').send({ tenantId: homeTenant.id, userId: supportAgent.id });
      const impersonateRes = await request(app).post('/platform-admin/impersonate').set('Authorization', `Bearer ${supportAgentToken}`).send({ tenantId: tenant.id });
      impersonationToken = impersonateRes.body.accessToken;
    });

    afterEach(() => {
      delete process.env.PLATFORM_ADMIN_BOOTSTRAP_SECRET;
    });

    test('message content is redacted by default during impersonation, revealed with ?reveal=true', async () => {
      await request(app).post('/messages').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({ customerId: customer.id, body: 'Sensitive customer info here' });

      const redacted = await request(app).get('/messages').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${impersonationToken}`);
      expect(redacted.status).toBe(200);
      expect(redacted.body[0].body).toMatch(/hidden/);

      const revealed = await request(app).get('/messages?reveal=true').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${impersonationToken}`);
      expect(revealed.body[0].body).toBe('Sensitive customer info here');
    });

    test('a real tenant member never has message content redacted', async () => {
      await request(app).post('/messages').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({ customerId: customer.id, body: 'Plain text' });
      const res = await request(app).get('/messages').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.body[0].body).toBe('Plain text');
    });
  });

  describe('Platform admin: unmatched messages', () => {
    let supportAgentToken;

    beforeEach(async () => {
      process.env.PLATFORM_ADMIN_BOOTSTRAP_SECRET = 'test-secret';
      const homeTenant = TenantRepository.create({ name: 'Ops', slug: 'ops' });
      const supportAgent = UserRepository.create({ tenantId: homeTenant.id, provider: 'google', providerId: 'g-support', email: 'support@ours.com' });
      supportAgentToken = signToken({ userId: supportAgent.id, tenantId: homeTenant.id });
      await request(app).post('/platform-admin/bootstrap-grant').set('x-bootstrap-secret', 'test-secret').send({ tenantId: homeTenant.id, userId: supportAgent.id });
    });

    afterEach(() => {
      delete process.env.PLATFORM_ADMIN_BOOTSTRAP_SECRET;
    });

    test('GET /platform-admin/messages/unmatched lists cross-tenant unmatched messages', async () => {
      await request(app).post('/webhooks/sms/console/inbound').send({ from: '+19995550000', to: '+15559998888', text: 'stray text' });

      const res = await request(app).get('/platform-admin/messages/unmatched').set('Authorization', `Bearer ${supportAgentToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    test('POST /platform-admin/messages/:id/reconcile attaches it to the right tenant/customer', async () => {
      await request(app).post('/webhooks/sms/console/inbound').send({ from: '+19995550000', to: '+15559998888', text: 'stray text' });
      const unmatched = MessageRepository.listUnmatched()[0];

      const res = await request(app)
        .post(`/platform-admin/messages/${unmatched.id}/reconcile`)
        .set('Authorization', `Bearer ${supportAgentToken}`)
        .send({ tenantId: tenant.id, customerId: customer.id });

      expect(res.status).toBe(200);
      expect(res.body.matchStatus).toBe('matched');
      expect(MessageRepository.listUnmatched()).toHaveLength(0);
    });

    test('a non-platform-admin gets 403', async () => {
      const res = await request(app).get('/platform-admin/messages/unmatched').set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('Cascade deletes', () => {
    test('deleting a job removes its messages', async () => {
      await request(app).post('/messages').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({ customerId: customer.id, jobId: job.id, body: 'hi' });

      const res = await request(app).delete(`/jobs/${job.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(204);
      expect(MessageRepository.listByJob(tenant.id, job.id)).toHaveLength(0);
    });

    test('deleting a customer removes all of their messages, job-scoped or not', async () => {
      await request(app).post('/messages').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({ customerId: customer.id, jobId: job.id, body: 'a' });
      await request(app).post('/messages').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({ customerId: customer.id, body: 'b' });

      const res = await request(app).delete(`/customers/${customer.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(204);
      expect(MessageRepository.listByCustomer(tenant.id, customer.id)).toHaveLength(0);
    });
  });
});
