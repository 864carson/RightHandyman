const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const CustomerRepository = require('../../src/models/Customer');
const JobRepository = require('../../src/models/Job');
const MessageRepository = require('../../src/models/Message');
const { resetSmsProvider, getSmsProvider } = require('../../src/services/sms');
const controller = require('../../src/controllers/messagingController');

describe('messagingController', () => {
  let tenant;
  let customer;
  let job;

  beforeEach(() => {
    reset();
    process.env.SMS_PROVIDER = 'console';
    process.env.SMS_FROM_NUMBER = '+15559998888';
    resetSmsProvider();
    getSmsProvider().reset();

    tenant = TenantRepository.create({ name: 'Acme', slug: 'acme' });
    customer = CustomerRepository.create({ tenantId: tenant.id, name: 'Jane', phone: '+15551234567' });
    job = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'Job' });
  });

  afterEach(() => {
    delete process.env.SMS_PROVIDER;
    delete process.env.SMS_FROM_NUMBER;
    resetSmsProvider();
  });

  describe('sendMessage', () => {
    test('sends successfully and records a "sent" message tied to the customer and job', async () => {
      const message = await controller.sendMessage(tenant.id, { customerId: customer.id, jobId: job.id, body: 'Hello!', createdBy: 'user-1' });

      expect(message.status).toBe('sent');
      expect(message.provider).toBe('console');
      expect(message.providerMessageId).toBeDefined();
      expect(message.toNumber).toBe('+15551234567');
      expect(message.fromNumber).toBe('+15559998888');
      expect(getSmsProvider().sentMessages).toHaveLength(1);
    });

    test('jobId is optional -- a message can be tied to just a customer', async () => {
      const message = await controller.sendMessage(tenant.id, { customerId: customer.id, body: 'Hi' });
      expect(message.jobId).toBeNull();
    });

    test('throws 400 when body is missing', async () => {
      await expect(controller.sendMessage(tenant.id, { customerId: customer.id })).rejects.toMatchObject({ status: 400 });
    });

    test('throws 404 for an unknown customer', async () => {
      await expect(controller.sendMessage(tenant.id, { customerId: 'ghost', body: 'hi' })).rejects.toMatchObject({ status: 404 });
    });

    test('throws 400 when the customer has no phone on file', async () => {
      const noPhone = CustomerRepository.create({ tenantId: tenant.id, name: 'No Phone' });
      await expect(controller.sendMessage(tenant.id, { customerId: noPhone.id, body: 'hi' })).rejects.toMatchObject({ status: 400 });
    });

    test('throws 404 for an unknown jobId', async () => {
      await expect(controller.sendMessage(tenant.id, { customerId: customer.id, jobId: 'ghost', body: 'hi' })).rejects.toMatchObject({ status: 404 });
    });

    test('throws 400 when the job belongs to a different customer', async () => {
      const otherCustomer = CustomerRepository.create({ tenantId: tenant.id, name: 'Other', phone: '+15550001111' });
      await expect(controller.sendMessage(tenant.id, { customerId: otherCustomer.id, jobId: job.id, body: 'hi' })).rejects.toMatchObject({
        status: 400
      });
    });

    test('throws 500 when SMS_FROM_NUMBER is not configured', async () => {
      delete process.env.SMS_FROM_NUMBER;
      await expect(controller.sendMessage(tenant.id, { customerId: customer.id, body: 'hi' })).rejects.toMatchObject({ status: 500 });
    });

    test('a provider send() failure is recorded as a failed message, not thrown', async () => {
      const provider = getSmsProvider();
      const originalSend = provider.send.bind(provider);
      provider.send = async () => {
        throw new Error('Carrier rejected the number');
      };

      const message = await controller.sendMessage(tenant.id, { customerId: customer.id, body: 'hi' });
      expect(message.status).toBe('failed');
      expect(message.errorMessage).toBe('Carrier rejected the number');

      provider.send = originalSend;
    });
  });

  describe('handleInboundWebhook', () => {
    test('matches a customer by phone number', () => {
      const message = controller.handleInboundWebhook('console', { from: '+15551234567', to: '+15559998888', text: 'Sounds good' }, {});
      expect(message.matchStatus).toBe('matched');
      expect(message.tenantId).toBe(tenant.id);
      expect(message.customerId).toBe(customer.id);
    });

    test('records unmatched when no customer has that phone number', () => {
      const message = controller.handleInboundWebhook('console', { from: '+19995550000', to: '+15559998888', text: 'Who is this' }, {});
      expect(message.matchStatus).toBe('unmatched');
      expect(message.tenantId).toBeNull();
    });

    test('records ambiguous when more than one customer (across tenants) shares that phone number', () => {
      const otherTenant = TenantRepository.create({ name: 'Other', slug: 'other' });
      CustomerRepository.create({ tenantId: otherTenant.id, name: 'Someone Else', phone: '+15551234567' });

      const message = controller.handleInboundWebhook('console', { from: '+15551234567', to: '+15559998888', text: 'hi' }, {});
      expect(message.matchStatus).toBe('ambiguous');
      expect(message.tenantId).toBeNull();
    });

    test('throws for an unknown provider name', () => {
      expect(() => controller.handleInboundWebhook('not_a_real_provider', {}, {})).toThrow(/Unknown SMS provider/);
    });
  });

  describe('handleStatusWebhook', () => {
    test('updates the matching message\'s status', async () => {
      const sent = await controller.sendMessage(tenant.id, { customerId: customer.id, body: 'hi' });
      const updated = controller.handleStatusWebhook('console', { messageId: sent.providerMessageId, status: 'delivered' }, {});
      expect(updated.id).toBe(sent.id);
      expect(updated.status).toBe('delivered');
    });

    test('returns null for a provider message id with no matching stored message', () => {
      const result = controller.handleStatusWebhook('console', { messageId: 'totally-unknown', status: 'delivered' }, {});
      expect(result).toBeNull();
    });
  });

  describe('reconcileMessage', () => {
    test('attaches an unmatched message to a tenant/customer/job', () => {
      const stray = MessageRepository.createInbound({ body: 'x', fromNumber: '+19995550000' });
      const reconciled = controller.reconcileMessage(stray.id, { tenantId: tenant.id, customerId: customer.id, jobId: job.id });
      expect(reconciled.matchStatus).toBe('matched');
      expect(reconciled.jobId).toBe(job.id);
    });

    test('throws 404 for an unknown tenant, customer, job, or message', () => {
      const stray = MessageRepository.createInbound({ body: 'x', fromNumber: '+1999' });
      expect(() => controller.reconcileMessage(stray.id, { tenantId: 'ghost', customerId: customer.id })).toThrow();
      expect(() => controller.reconcileMessage(stray.id, { tenantId: tenant.id, customerId: 'ghost' })).toThrow();
      expect(() => controller.reconcileMessage(stray.id, { tenantId: tenant.id, customerId: customer.id, jobId: 'ghost' })).toThrow();
      expect(() => controller.reconcileMessage('ghost-message', { tenantId: tenant.id, customerId: customer.id })).toThrow();
    });
  });
});
