const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const CustomerRepository = require('../../src/models/Customer');
const JobRepository = require('../../src/models/Job');

describe('JobRepository', () => {
  let tenantA;
  let tenantB;
  let customerA;

  beforeEach(() => {
    reset();
    tenantA = TenantRepository.create({ name: 'Tenant A', slug: 'tenant-a' });
    tenantB = TenantRepository.create({ name: 'Tenant B', slug: 'tenant-b' });
    customerA = CustomerRepository.create({ tenantId: tenantA.id, name: 'Jane Homeowner' });
  });

  test('creates a job with sensible defaults', () => {
    const job = JobRepository.create({ tenantId: tenantA.id, customerId: customerA.id, title: 'Backyard drainage' });

    expect(job.id).toBeDefined();
    expect(job.status).toBe('estimating');
    expect(job.currentEstimateId).toBeNull();
    expect(job.opportunityId).toBeNull();
    expect(job.weatherSensitive).toBe(false);
    expect(job.photos).toEqual([]);
  });

  test('rejects creation without tenantId, customerId, or title', () => {
    expect(() => JobRepository.create({ customerId: customerA.id, title: 'X' })).toThrow(/required/);
    expect(() => JobRepository.create({ tenantId: tenantA.id, title: 'X' })).toThrow(/required/);
    expect(() => JobRepository.create({ tenantId: tenantA.id, customerId: customerA.id })).toThrow(/required/);
  });

  test('rejects a non-array photos field', () => {
    expect(() =>
      JobRepository.create({ tenantId: tenantA.id, customerId: customerA.id, title: 'X', photos: 'not-an-array' })
    ).toThrow(/photos must be an array/);
  });

  test('captures weather/season-sensitivity flags', () => {
    const job = JobRepository.create({
      tenantId: tenantA.id,
      customerId: customerA.id,
      title: 'Exterior paint',
      weatherSensitive: true,
      weatherNotes: 'Paint only if dry for 48 hrs'
    });

    expect(job.weatherSensitive).toBe(true);
    expect(job.weatherNotes).toBe('Paint only if dry for 48 hrs');
  });

  test('findById returns null for a job in a different tenant', () => {
    const job = JobRepository.create({ tenantId: tenantA.id, customerId: customerA.id, title: 'X' });
    expect(JobRepository.findById(tenantB.id, job.id)).toBeNull();
  });

  test('listByTenant and listByCustomer scope correctly', () => {
    const otherCustomer = CustomerRepository.create({ tenantId: tenantA.id, name: 'Other Customer' });
    JobRepository.create({ tenantId: tenantA.id, customerId: customerA.id, title: 'Job 1' });
    JobRepository.create({ tenantId: tenantA.id, customerId: customerA.id, title: 'Job 2' });
    JobRepository.create({ tenantId: tenantA.id, customerId: otherCustomer.id, title: 'Job 3' });

    expect(JobRepository.listByTenant(tenantA.id)).toHaveLength(3);
    expect(JobRepository.listByCustomer(tenantA.id, customerA.id)).toHaveLength(2);
    expect(JobRepository.listByCustomer(tenantA.id, otherCustomer.id)).toHaveLength(1);
  });

  test('update() changes mutable fields', () => {
    const job = JobRepository.create({ tenantId: tenantA.id, customerId: customerA.id, title: 'Job' });
    const updated = JobRepository.update(tenantA.id, job.id, { status: 'scheduled', notes: 'Bring extra pipe' });

    expect(updated.status).toBe('scheduled');
    expect(updated.notes).toBe('Bring extra pipe');
  });

  test('update() rejects an invalid status', () => {
    const job = JobRepository.create({ tenantId: tenantA.id, customerId: customerA.id, title: 'Job' });
    expect(() => JobRepository.update(tenantA.id, job.id, { status: 'bogus' })).toThrow(/status must be one of/);
  });

  test('update() returns null for a job in a different tenant', () => {
    const job = JobRepository.create({ tenantId: tenantA.id, customerId: customerA.id, title: 'Job' });
    expect(JobRepository.update(tenantB.id, job.id, { status: 'scheduled' })).toBeNull();
  });

  test('setCurrentEstimate points the job at an estimate version', () => {
    const job = JobRepository.create({ tenantId: tenantA.id, customerId: customerA.id, title: 'Job' });
    const updated = JobRepository.setCurrentEstimate(tenantA.id, job.id, 'estimate-123');
    expect(updated.currentEstimateId).toBe('estimate-123');
  });

  test('delete() and deleteAllForCustomer scope correctly', () => {
    JobRepository.create({ tenantId: tenantA.id, customerId: customerA.id, title: 'Job 1' });
    JobRepository.create({ tenantId: tenantA.id, customerId: customerA.id, title: 'Job 2' });

    const count = JobRepository.deleteAllForCustomer(tenantA.id, customerA.id);

    expect(count).toBe(2);
    expect(JobRepository.listByCustomer(tenantA.id, customerA.id)).toHaveLength(0);
  });

  test('deleteAllForTenant removes only that tenant\'s jobs', () => {
    const customerB = CustomerRepository.create({ tenantId: tenantB.id, name: 'Acme' });
    JobRepository.create({ tenantId: tenantA.id, customerId: customerA.id, title: 'Job A' });
    JobRepository.create({ tenantId: tenantB.id, customerId: customerB.id, title: 'Job B' });

    const count = JobRepository.deleteAllForTenant(tenantA.id);

    expect(count).toBe(1);
    expect(JobRepository.listByTenant(tenantA.id)).toHaveLength(0);
    expect(JobRepository.listByTenant(tenantB.id)).toHaveLength(1);
  });
});
