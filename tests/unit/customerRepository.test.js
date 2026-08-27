const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const CustomerRepository = require('../../src/models/Customer');
const OpportunityRepository = require('../../src/models/Opportunity');

describe('CustomerRepository', () => {
  let tenantA;
  let tenantB;

  beforeEach(() => {
    reset();
    tenantA = TenantRepository.create({ name: 'Tenant A', slug: 'tenant-a' });
    tenantB = TenantRepository.create({ name: 'Tenant B', slug: 'tenant-b' });
  });

  test('creates a customer scoped to a tenant', () => {
    const customer = CustomerRepository.create({
      tenantId: tenantA.id,
      name: 'Wayne Enterprises',
      email: 'Contact@Wayne.com',
      createdBy: 'user-1'
    });

    expect(customer.id).toBeDefined();
    expect(customer.tenantId).toBe(tenantA.id);
    expect(customer.email).toBe('contact@wayne.com');
  });

  test('rejects creation without a name', () => {
    expect(() => CustomerRepository.create({ tenantId: tenantA.id })).toThrow(/required/);
  });

  test('rejects creation without a tenantId', () => {
    expect(() => CustomerRepository.create({ name: 'X' })).toThrow(/required/);
  });

  test('findById returns null for a customer in a different tenant', () => {
    const customer = CustomerRepository.create({ tenantId: tenantA.id, name: 'Wayne Enterprises' });
    expect(CustomerRepository.findById(tenantB.id, customer.id)).toBeNull();
    expect(CustomerRepository.findById(tenantA.id, customer.id)).toEqual(customer);
  });

  test('listByTenant only returns that tenant\'s customers', () => {
    CustomerRepository.create({ tenantId: tenantA.id, name: 'A1' });
    CustomerRepository.create({ tenantId: tenantA.id, name: 'A2' });
    CustomerRepository.create({ tenantId: tenantB.id, name: 'B1' });

    expect(CustomerRepository.listByTenant(tenantA.id)).toHaveLength(2);
    expect(CustomerRepository.listByTenant(tenantB.id)).toHaveLength(1);
  });

  test('update() changes mutable fields only', () => {
    const customer = CustomerRepository.create({ tenantId: tenantA.id, name: 'Wayne Enterprises' });
    const updated = CustomerRepository.update(tenantA.id, customer.id, {
      name: 'Wayne Ent.',
      phone: '555-1234',
      company: 'Wayne Enterprises Inc'
    });

    expect(updated.name).toBe('Wayne Ent.');
    expect(updated.phone).toBe('555-1234');
  });

  test('update() returns null for a customer in a different tenant', () => {
    const customer = CustomerRepository.create({ tenantId: tenantA.id, name: 'Wayne Enterprises' });
    expect(CustomerRepository.update(tenantB.id, customer.id, { name: 'Hacked' })).toBeNull();
  });

  test('delete() removes the customer', () => {
    const customer = CustomerRepository.create({ tenantId: tenantA.id, name: 'Wayne Enterprises' });
    expect(CustomerRepository.delete(tenantA.id, customer.id)).toBe(true);
    expect(CustomerRepository.findById(tenantA.id, customer.id)).toBeNull();
  });

  test('delete() returns false for a customer in a different tenant', () => {
    const customer = CustomerRepository.create({ tenantId: tenantA.id, name: 'Wayne Enterprises' });
    expect(CustomerRepository.delete(tenantB.id, customer.id)).toBe(false);
  });

  test('deleteAllForTenant removes only that tenant\'s customers', () => {
    CustomerRepository.create({ tenantId: tenantA.id, name: 'A1' });
    CustomerRepository.create({ tenantId: tenantA.id, name: 'A2' });
    CustomerRepository.create({ tenantId: tenantB.id, name: 'B1' });

    const count = CustomerRepository.deleteAllForTenant(tenantA.id);

    expect(count).toBe(2);
    expect(CustomerRepository.listByTenant(tenantA.id)).toHaveLength(0);
    expect(CustomerRepository.listByTenant(tenantB.id)).toHaveLength(1);
  });

  test('deleting a customer does not automatically delete its opportunities (repository level)', () => {
    // Cascading delete is a route-layer concern (see routes/customer.js);
    // the repository itself just manages customer rows.
    const customer = CustomerRepository.create({ tenantId: tenantA.id, name: 'Wayne Enterprises' });
    OpportunityRepository.create({ tenantId: tenantA.id, customerId: customer.id, name: 'Batmobile deal' });

    CustomerRepository.delete(tenantA.id, customer.id);

    expect(OpportunityRepository.listByCustomer(tenantA.id, customer.id)).toHaveLength(1);
  });
});
