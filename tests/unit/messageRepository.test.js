const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const CustomerRepository = require('../../src/models/Customer');
const MessageRepository = require('../../src/models/Message');

describe('CustomerRepository.findAllByPhone', () => {
  beforeEach(() => {
    reset();
  });

  test('matches across common formats via normalized digits', () => {
    const tenant = TenantRepository.create({ name: 'Acme', slug: 'acme' });
    CustomerRepository.create({ tenantId: tenant.id, name: 'Jane', phone: '+1 (555) 123-4567' });

    expect(CustomerRepository.findAllByPhone('5551234567')).toHaveLength(1);
    expect(CustomerRepository.findAllByPhone('+15551234567')).toHaveLength(1);
    expect(CustomerRepository.findAllByPhone('(555) 123-4567')).toHaveLength(1);
    expect(CustomerRepository.findAllByPhone('555-123-4567')).toHaveLength(1);
  });

  test('returns empty for no match, and for a missing/empty phone', () => {
    expect(CustomerRepository.findAllByPhone('9998887777')).toHaveLength(0);
    expect(CustomerRepository.findAllByPhone(null)).toHaveLength(0);
    expect(CustomerRepository.findAllByPhone('')).toHaveLength(0);
  });

  test('returns every match across every tenant (ambiguous case)', () => {
    const t1 = TenantRepository.create({ name: 'Acme', slug: 'acme' });
    const t2 = TenantRepository.create({ name: 'Other', slug: 'other' });
    CustomerRepository.create({ tenantId: t1.id, name: 'Jane', phone: '5551234567' });
    CustomerRepository.create({ tenantId: t2.id, name: 'Someone Else', phone: '555-123-4567' });

    expect(CustomerRepository.findAllByPhone('5551234567')).toHaveLength(2);
  });
});

describe('MessageRepository', () => {
  const tenantId = 'tenant-1';
  const customerId = 'customer-1';
  const jobId = 'job-1';

  beforeEach(() => {
    reset();
  });

  describe('create (outbound)', () => {
    test('creates a queued outbound message', () => {
      const message = MessageRepository.create({ tenantId, customerId, jobId, body: 'hi', toNumber: '+1555', fromNumber: '+1556', provider: 'console' });
      expect(message.direction).toBe('outbound');
      expect(message.status).toBe('queued');
      expect(message.matchStatus).toBe('matched');
      expect(message.providerMessageId).toBeNull();
    });

    test('rejects creation without tenantId, customerId, body, or toNumber', () => {
      expect(() => MessageRepository.create({ customerId, body: 'hi', toNumber: '+1555' })).toThrow(/required/);
      expect(() => MessageRepository.create({ tenantId, body: 'hi', toNumber: '+1555' })).toThrow(/required/);
      expect(() => MessageRepository.create({ tenantId, customerId, toNumber: '+1555' })).toThrow(/required/);
      expect(() => MessageRepository.create({ tenantId, customerId, body: 'hi' })).toThrow(/required/);
    });

    test('jobId is optional', () => {
      const message = MessageRepository.create({ tenantId, customerId, body: 'hi', toNumber: '+1555' });
      expect(message.jobId).toBeNull();
    });
  });

  describe('createInbound', () => {
    test('a matched inbound message (tenantId+customerId provided) is marked matched', () => {
      const message = MessageRepository.createInbound({ tenantId, customerId, body: 'reply', fromNumber: '+1555', provider: 'console' });
      expect(message.direction).toBe('inbound');
      expect(message.status).toBe('received');
      expect(message.matchStatus).toBe('matched');
    });

    test('an inbound message with no tenant/customer defaults to unmatched', () => {
      const message = MessageRepository.createInbound({ body: 'who is this', fromNumber: '+19995551111', provider: 'console' });
      expect(message.matchStatus).toBe('unmatched');
      expect(message.tenantId).toBeNull();
      expect(message.customerId).toBeNull();
    });

    test('an explicit matchStatus (e.g. "ambiguous") is respected', () => {
      const message = MessageRepository.createInbound({ body: 'x', fromNumber: '+1555', matchStatus: 'ambiguous' });
      expect(message.matchStatus).toBe('ambiguous');
    });

    test('rejects an invalid matchStatus', () => {
      expect(() => MessageRepository.createInbound({ body: 'x', fromNumber: '+1555', matchStatus: 'bogus' })).toThrow(/matchStatus must be one of/);
    });

    test('rejects creation without body or fromNumber', () => {
      expect(() => MessageRepository.createInbound({ fromNumber: '+1555' })).toThrow(/required/);
      expect(() => MessageRepository.createInbound({ body: 'x' })).toThrow(/required/);
    });
  });

  describe('findById / findByProviderMessageId', () => {
    test('findById is tenant-scoped', () => {
      const message = MessageRepository.create({ tenantId, customerId, body: 'hi', toNumber: '+1555' });
      expect(MessageRepository.findById('other-tenant', message.id)).toBeNull();
      expect(MessageRepository.findById(tenantId, message.id).id).toBe(message.id);
    });

    test('findByProviderMessageId is cross-tenant (webhooks don\'t know the tenant)', () => {
      const message = MessageRepository.create({ tenantId, customerId, body: 'hi', toNumber: '+1555' });
      MessageRepository.setProviderMessageId(message.id, 'provider-abc');
      expect(MessageRepository.findByProviderMessageId('provider-abc').id).toBe(message.id);
      expect(MessageRepository.findByProviderMessageId('unknown')).toBeNull();
    });
  });

  describe('updateStatus', () => {
    test('updates status and errorMessage, not tenant-scoped (webhook-driven)', () => {
      const message = MessageRepository.create({ tenantId, customerId, body: 'hi', toNumber: '+1555' });
      const updated = MessageRepository.updateStatus(message.id, { status: 'failed', errorMessage: 'carrier rejected' });
      expect(updated.status).toBe('failed');
      expect(updated.errorMessage).toBe('carrier rejected');
    });

    test('rejects an invalid status', () => {
      const message = MessageRepository.create({ tenantId, customerId, body: 'hi', toNumber: '+1555' });
      expect(() => MessageRepository.updateStatus(message.id, { status: 'bogus' })).toThrow(/status must be one of/);
    });

    test('returns null for an unknown id', () => {
      expect(MessageRepository.updateStatus('ghost', { status: 'sent' })).toBeNull();
    });
  });

  describe('listByCustomer / listByJob / listByTenant', () => {
    test('scope correctly', () => {
      MessageRepository.create({ tenantId, customerId, jobId, body: 'a', toNumber: '+1' });
      MessageRepository.create({ tenantId, customerId, body: 'b', toNumber: '+1' }); // no job
      MessageRepository.create({ tenantId, customerId: 'other-customer', body: 'c', toNumber: '+1' });

      expect(MessageRepository.listByCustomer(tenantId, customerId)).toHaveLength(2);
      expect(MessageRepository.listByJob(tenantId, jobId)).toHaveLength(1);
      expect(MessageRepository.listByTenant(tenantId)).toHaveLength(3);
    });
  });

  describe('listUnmatched / reconcile', () => {
    test('listUnmatched returns only messages with no tenant, matched excluded', () => {
      MessageRepository.create({ tenantId, customerId, body: 'a', toNumber: '+1' }); // matched, has tenant
      MessageRepository.createInbound({ body: 'b', fromNumber: '+1999' }); // unmatched
      MessageRepository.createInbound({ body: 'c', fromNumber: '+1888', matchStatus: 'ambiguous' }); // ambiguous

      expect(MessageRepository.listUnmatched()).toHaveLength(2);
    });

    test('reconcile attaches tenant/customer and flips matchStatus to matched', () => {
      const stray = MessageRepository.createInbound({ body: 'who is this', fromNumber: '+1999' });
      const reconciled = MessageRepository.reconcile(stray.id, { tenantId, customerId, jobId });

      expect(reconciled.tenantId).toBe(tenantId);
      expect(reconciled.customerId).toBe(customerId);
      expect(reconciled.jobId).toBe(jobId);
      expect(reconciled.matchStatus).toBe('matched');
      expect(MessageRepository.listUnmatched()).toHaveLength(0);
    });

    test('reconcile requires tenantId and customerId', () => {
      const stray = MessageRepository.createInbound({ body: 'x', fromNumber: '+1999' });
      expect(() => MessageRepository.reconcile(stray.id, { customerId })).toThrow(/required/);
      expect(() => MessageRepository.reconcile(stray.id, { tenantId })).toThrow(/required/);
    });

    test('reconcile returns null for an unknown message', () => {
      expect(MessageRepository.reconcile('ghost', { tenantId, customerId })).toBeNull();
    });
  });

  describe('cascade deletes', () => {
    test('deleteAllForCustomer / deleteAllForJob / deleteAllForTenant', () => {
      MessageRepository.create({ tenantId, customerId, jobId, body: 'a', toNumber: '+1' });
      MessageRepository.create({ tenantId, customerId, body: 'b', toNumber: '+1' });

      expect(MessageRepository.deleteAllForJob(tenantId, jobId)).toBe(1);
      expect(MessageRepository.listByTenant(tenantId)).toHaveLength(1);

      expect(MessageRepository.deleteAllForCustomer(tenantId, customerId)).toBe(1);
      expect(MessageRepository.listByTenant(tenantId)).toHaveLength(0);

      MessageRepository.create({ tenantId, customerId, body: 'c', toNumber: '+1' });
      expect(MessageRepository.deleteAllForTenant(tenantId)).toBe(1);
      expect(MessageRepository.listByTenant(tenantId)).toHaveLength(0);
    });
  });
});
