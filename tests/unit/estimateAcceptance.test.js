const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const EstimateAcceptanceRepository = require('../../src/models/EstimateAcceptance');

describe('EstimateAcceptanceRepository', () => {
  let tenant;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme', slug: 'acme' });
  });

  test('records an entry with all the expected fields', () => {
    const entry = EstimateAcceptanceRepository.record({
      tenantId: tenant.id,
      estimateId: 'est-1',
      action: 'accepted',
      name: 'Jane Homeowner',
      email: 'jane@example.com',
      ipAddress: '203.0.113.5',
      userAgent: 'Mozilla/5.0',
      tokenLast8: 'abcd1234'
    });

    expect(entry.id).toBeDefined();
    expect(entry.action).toBe('accepted');
    expect(entry.signatureType).toBe('typed_name');
    expect(entry.name).toBe('Jane Homeowner');
    expect(entry.email).toBe('jane@example.com');
    expect(entry.ipAddress).toBe('203.0.113.5');
    expect(entry.userAgent).toBe('Mozilla/5.0');
    expect(entry.tokenLast8).toBe('abcd1234');
    expect(entry.createdAt).toBeDefined();
  });

  test('requires tenantId, estimateId, action, and name', () => {
    expect(() => EstimateAcceptanceRepository.record({ estimateId: 'e1', action: 'accepted', name: 'Jane' })).toThrow(/required/);
    expect(() => EstimateAcceptanceRepository.record({ tenantId: tenant.id, action: 'accepted', name: 'Jane' })).toThrow(/required/);
    expect(() => EstimateAcceptanceRepository.record({ tenantId: tenant.id, estimateId: 'e1', name: 'Jane' })).toThrow(/required/);
    expect(() => EstimateAcceptanceRepository.record({ tenantId: tenant.id, estimateId: 'e1', action: 'accepted' })).toThrow(/required/);
  });

  test('rejects an invalid action', () => {
    expect(() =>
      EstimateAcceptanceRepository.record({ tenantId: tenant.id, estimateId: 'e1', action: 'bogus', name: 'Jane' })
    ).toThrow(/action must be one of/);
  });

  test('email, ipAddress, userAgent, tokenLast8, and reason are optional', () => {
    const entry = EstimateAcceptanceRepository.record({ tenantId: tenant.id, estimateId: 'e1', action: 'rejected', name: 'Jane' });
    expect(entry.email).toBeNull();
    expect(entry.ipAddress).toBeNull();
    expect(entry.userAgent).toBeNull();
    expect(entry.tokenLast8).toBeNull();
    expect(entry.reason).toBeNull();
  });

  test('listForEstimate returns every event for that estimate, oldest first, scoped to tenant', () => {
    EstimateAcceptanceRepository.record({ tenantId: tenant.id, estimateId: 'e1', action: 'accepted', name: 'Jane' });
    EstimateAcceptanceRepository.record({ tenantId: tenant.id, estimateId: 'e1', action: 'rejected', name: 'Bob' });
    EstimateAcceptanceRepository.record({ tenantId: tenant.id, estimateId: 'e2', action: 'accepted', name: 'Someone Else' });

    const events = EstimateAcceptanceRepository.listForEstimate(tenant.id, 'e1');
    expect(events).toHaveLength(2);
    expect(events[0].name).toBe('Jane');
    expect(events[1].name).toBe('Bob');

    const otherTenant = TenantRepository.create({ name: 'Other', slug: 'other' });
    expect(EstimateAcceptanceRepository.listForEstimate(otherTenant.id, 'e1')).toHaveLength(0);
  });

  test('findLatestForEstimate returns the most recent event of a given action, or null', () => {
    EstimateAcceptanceRepository.record({ tenantId: tenant.id, estimateId: 'e1', action: 'accepted', name: 'Jane' });
    const second = EstimateAcceptanceRepository.record({ tenantId: tenant.id, estimateId: 'e1', action: 'accepted', name: 'Jane (again)' });

    const latest = EstimateAcceptanceRepository.findLatestForEstimate(tenant.id, 'e1', 'accepted');
    expect(latest.id).toBe(second.id);

    expect(EstimateAcceptanceRepository.findLatestForEstimate(tenant.id, 'e1', 'rejected')).toBeNull();
    expect(EstimateAcceptanceRepository.findLatestForEstimate(tenant.id, 'nonexistent-estimate', 'accepted')).toBeNull();
  });

  test('has no update() or delete() method -- the ledger is append-only by design', () => {
    expect(EstimateAcceptanceRepository.update).toBeUndefined();
    expect(EstimateAcceptanceRepository.delete).toBeUndefined();
  });

  test('survives a full db reset only when reset() is explicitly called -- not cascade-deletable via any exposed method', () => {
    // There is deliberately no deleteAllForTenant/deleteAllForEstimate on
    // this repository (see models/AuditLog.js for the same pattern) --
    // this test exists to make that omission a first-class, checked
    // invariant rather than something only a code comment claims.
    expect(EstimateAcceptanceRepository.deleteAllForTenant).toBeUndefined();
    expect(EstimateAcceptanceRepository.deleteAllForEstimate).toBeUndefined();
  });
});
