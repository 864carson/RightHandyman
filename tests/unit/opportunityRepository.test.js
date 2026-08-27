const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const CustomerRepository = require('../../src/models/Customer');
const OpportunityRepository = require('../../src/models/Opportunity');

describe('OpportunityRepository', () => {
  let tenantA;
  let tenantB;
  let customerA;

  beforeEach(() => {
    reset();
    tenantA = TenantRepository.create({ name: 'Tenant A', slug: 'tenant-a' });
    tenantB = TenantRepository.create({ name: 'Tenant B', slug: 'tenant-b' });
    customerA = CustomerRepository.create({ tenantId: tenantA.id, name: 'Wayne Enterprises' });
  });

  test('creates an opportunity with sensible defaults', () => {
    const opp = OpportunityRepository.create({ tenantId: tenantA.id, customerId: customerA.id, name: 'Batmobile deal' });

    expect(opp.id).toBeDefined();
    expect(opp.stage).toBe('lead');
    expect(opp.currency).toBe('USD');
    expect(opp.amount).toBeNull();
  });

  test('rejects creation without tenantId, customerId, or name', () => {
    expect(() => OpportunityRepository.create({ customerId: customerA.id, name: 'X' })).toThrow(/required/);
    expect(() => OpportunityRepository.create({ tenantId: tenantA.id, name: 'X' })).toThrow(/required/);
    expect(() => OpportunityRepository.create({ tenantId: tenantA.id, customerId: customerA.id })).toThrow(/required/);
  });

  test('rejects an invalid stage', () => {
    expect(() =>
      OpportunityRepository.create({ tenantId: tenantA.id, customerId: customerA.id, name: 'X', stage: 'bogus' })
    ).toThrow(/stage must be one of/);
  });

  test('rejects a non-numeric amount', () => {
    expect(() =>
      OpportunityRepository.create({ tenantId: tenantA.id, customerId: customerA.id, name: 'X', amount: 'lots' })
    ).toThrow(/amount must be a number/);
  });

  test('findById returns null for an opportunity in a different tenant', () => {
    const opp = OpportunityRepository.create({ tenantId: tenantA.id, customerId: customerA.id, name: 'Deal' });
    expect(OpportunityRepository.findById(tenantB.id, opp.id)).toBeNull();
  });

  test('listByTenant and listByCustomer scope correctly', () => {
    const otherCustomer = CustomerRepository.create({ tenantId: tenantA.id, name: 'Stark Industries' });
    OpportunityRepository.create({ tenantId: tenantA.id, customerId: customerA.id, name: 'Deal 1' });
    OpportunityRepository.create({ tenantId: tenantA.id, customerId: customerA.id, name: 'Deal 2' });
    OpportunityRepository.create({ tenantId: tenantA.id, customerId: otherCustomer.id, name: 'Deal 3' });

    expect(OpportunityRepository.listByTenant(tenantA.id)).toHaveLength(3);
    expect(OpportunityRepository.listByCustomer(tenantA.id, customerA.id)).toHaveLength(2);
    expect(OpportunityRepository.listByCustomer(tenantA.id, otherCustomer.id)).toHaveLength(1);
  });

  test('update() changes mutable fields and validates stage/amount', () => {
    const opp = OpportunityRepository.create({ tenantId: tenantA.id, customerId: customerA.id, name: 'Deal' });
    const updated = OpportunityRepository.update(tenantA.id, opp.id, { stage: 'won', amount: 50000 });

    expect(updated.stage).toBe('won');
    expect(updated.amount).toBe(50000);
  });

  test('update() rejects an invalid stage', () => {
    const opp = OpportunityRepository.create({ tenantId: tenantA.id, customerId: customerA.id, name: 'Deal' });
    expect(() => OpportunityRepository.update(tenantA.id, opp.id, { stage: 'bogus' })).toThrow(/stage must be one of/);
  });

  test('delete() and deleteAllForCustomer scope correctly', () => {
    OpportunityRepository.create({ tenantId: tenantA.id, customerId: customerA.id, name: 'Deal 1' });
    OpportunityRepository.create({ tenantId: tenantA.id, customerId: customerA.id, name: 'Deal 2' });

    const count = OpportunityRepository.deleteAllForCustomer(tenantA.id, customerA.id);

    expect(count).toBe(2);
    expect(OpportunityRepository.listByCustomer(tenantA.id, customerA.id)).toHaveLength(0);
  });

  test('deleteAllForTenant removes only that tenant\'s opportunities', () => {
    const customerB = CustomerRepository.create({ tenantId: tenantB.id, name: 'Acme' });
    OpportunityRepository.create({ tenantId: tenantA.id, customerId: customerA.id, name: 'Deal A' });
    OpportunityRepository.create({ tenantId: tenantB.id, customerId: customerB.id, name: 'Deal B' });

    const count = OpportunityRepository.deleteAllForTenant(tenantA.id);

    expect(count).toBe(1);
    expect(OpportunityRepository.listByTenant(tenantA.id)).toHaveLength(0);
    expect(OpportunityRepository.listByTenant(tenantB.id)).toHaveLength(1);
  });
});
