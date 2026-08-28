const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const CustomerRepository = require('../../src/models/Customer');
const JobRepository = require('../../src/models/Job');
const EstimateRepository = require('../../src/models/Estimate');
const { isPastValidity } = require('../../src/models/Estimate');

describe('EstimateRepository', () => {
  let tenantA;
  let tenantB;
  let job;

  beforeEach(() => {
    reset();
    tenantA = TenantRepository.create({ name: 'Tenant A', slug: 'tenant-a' });
    tenantB = TenantRepository.create({ name: 'Tenant B', slug: 'tenant-b' });
    const customer = CustomerRepository.create({ tenantId: tenantA.id, name: 'Jane Homeowner' });
    job = JobRepository.create({ tenantId: tenantA.id, customerId: customer.id, title: 'Mulch bed refresh' });
  });

  describe('create', () => {
    test('creates version 1 in draft status with a share token', () => {
      const estimate = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id, title: 'Estimate' });

      expect(estimate.version).toBe(1);
      expect(estimate.status).toBe('draft');
      expect(estimate.rootEstimateId).toBe(estimate.id);
      expect(estimate.previousVersionId).toBeNull();
      expect(estimate.isChangeOrder).toBe(false);
      expect(estimate.shareToken).toBeDefined();
      expect(estimate.validUntil).toBeDefined();
    });

    test('rejects creation without tenantId or jobId', () => {
      expect(() => EstimateRepository.create({ jobId: job.id })).toThrow(/required/);
      expect(() => EstimateRepository.create({ tenantId: tenantA.id })).toThrow(/required/);
    });

    test('rejects an invalid depositType', () => {
      expect(() => EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id, depositType: 'bogus' })).toThrow(
        /depositType must be one of/
      );
    });

    test('normalizes line items and fills in category-based default markup', () => {
      const estimate = EstimateRepository.create({
        tenantId: tenantA.id,
        jobId: job.id,
        lineItems: [{ description: 'Mulch', category: 'materials', unit: 'yard', quantity: 5, unitCost: 28 }]
      });

      expect(estimate.lineItems[0].markupValue).toBe(30); // default materials markup
      expect(estimate.lineItems[0].id).toBeDefined();
    });

    test('rejects a line item missing description or unit', () => {
      expect(() =>
        EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id, lineItems: [{ unit: 'yard', quantity: 1 }] })
      ).toThrow(/description/);
    });

    test('applies default change-order notice and payment terms when not provided', () => {
      const estimate = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id });
      expect(estimate.changeOrderNotice).toMatch(/change order/i);
      expect(estimate.paymentTerms).toMatch(/deposit/i);
    });
  });

  describe('findByShareToken', () => {
    test('finds an estimate by its token with no tenant scoping needed', () => {
      const estimate = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id });
      const found = EstimateRepository.findByShareToken(estimate.shareToken);
      expect(found.id).toBe(estimate.id);
    });

    test('returns null for an unknown token', () => {
      expect(EstimateRepository.findByShareToken('not-a-real-token')).toBeNull();
    });
  });

  describe('update (draft-only edit)', () => {
    test('edits a draft in place', () => {
      const estimate = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id, title: 'Original' });
      const updated = EstimateRepository.update(tenantA.id, estimate.id, { title: 'Renamed' });
      expect(updated.title).toBe('Renamed');
    });

    test('rejects editing a non-draft estimate with a 409', () => {
      const estimate = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id });
      EstimateRepository.markSent(tenantA.id, estimate.id);

      expect.assertions(2);
      try {
        EstimateRepository.update(tenantA.id, estimate.id, { title: 'x' });
      } catch (err) {
        expect(err.status).toBe(409);
        expect(err.message).toMatch(/only a draft can be edited|reviseEstimate/i);
      }
    });

    test('returns null for an estimate in a different tenant', () => {
      const estimate = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id });
      expect(EstimateRepository.update(tenantB.id, estimate.id, { title: 'x' })).toBeNull();
    });
  });

  describe('status transitions', () => {
    test('draft -> sent -> approved happy path', () => {
      const estimate = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id });

      const sent = EstimateRepository.markSent(tenantA.id, estimate.id);
      expect(sent.status).toBe('sent');
      expect(sent.sentAt).toBeDefined();

      const approved = EstimateRepository.approve(tenantA.id, estimate.id, { approvedByName: 'Jane Homeowner' });
      expect(approved.status).toBe('approved');
      expect(approved.approvedBy.name).toBe('Jane Homeowner');
    });

    test('approve() is also allowed directly from draft (verbal/in-person approval)', () => {
      const estimate = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id });
      const approved = EstimateRepository.approve(tenantA.id, estimate.id, {});
      expect(approved.status).toBe('approved');
    });

    test('cannot send a non-draft estimate', () => {
      const estimate = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id });
      EstimateRepository.markSent(tenantA.id, estimate.id);
      expect(() => EstimateRepository.markSent(tenantA.id, estimate.id)).toThrow(/Cannot send/);
    });

    test('cannot approve an already-rejected estimate', () => {
      const estimate = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id });
      EstimateRepository.reject(tenantA.id, estimate.id, { reason: 'Too expensive' });
      expect(() => EstimateRepository.approve(tenantA.id, estimate.id, {})).toThrow(/Cannot approve/);
    });

    test('reject() records a reason', () => {
      const estimate = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id });
      const rejected = EstimateRepository.reject(tenantA.id, estimate.id, { reason: 'Went with another company' });
      expect(rejected.status).toBe('rejected');
      expect(rejected.rejectionReason).toBe('Went with another company');
    });

    test('expire() moves draft/sent to expired but not other statuses', () => {
      const estimate = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id });
      const expired = EstimateRepository.expire(tenantA.id, estimate.id);
      expect(expired.status).toBe('expired');

      expect(() => EstimateRepository.expire(tenantA.id, estimate.id)).toThrow(/Cannot expire/);
    });
  });

  describe('isPastValidity', () => {
    test('true once validUntil has passed for a draft/sent estimate', () => {
      const estimate = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id, validDays: 1 });
      const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
      expect(isPastValidity(estimate, future)).toBe(true);
      expect(isPastValidity(estimate, new Date())).toBe(false);
    });

    test('false for a non-draft/sent estimate regardless of date (approved/rejected estimates don\'t "expire")', () => {
      const estimate = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id, validDays: 1 });
      const approved = EstimateRepository.approve(tenantA.id, estimate.id, {});
      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      expect(isPastValidity(approved, future)).toBe(false);
    });
  });

  describe('createRevision (versioning + change orders)', () => {
    test('a plain revision creates version 2 and supersedes a draft parent', () => {
      const v1 = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id, title: 'Original' });
      const v2 = EstimateRepository.createRevision(tenantA.id, v1.id, { title: 'Revised' });

      expect(v2.version).toBe(2);
      expect(v2.previousVersionId).toBe(v1.id);
      expect(v2.rootEstimateId).toBe(v1.id);
      expect(v2.isChangeOrder).toBe(false);
      expect(v2.status).toBe('draft');

      const v1Reloaded = EstimateRepository.findById(tenantA.id, v1.id);
      expect(v1Reloaded.status).toBe('superseded');
      expect(v1Reloaded.supersededBy).toBe(v2.id);
    });

    test('fields not passed in the revision are carried over from the parent', () => {
      const v1 = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id, title: 'Original', taxRate: 7 });
      const v2 = EstimateRepository.createRevision(tenantA.id, v1.id, { title: 'Revised' });
      expect(v2.taxRate).toBe(7);
    });

    test('a change order requires the parent to be approved', () => {
      const v1 = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id });
      expect(() => EstimateRepository.createRevision(tenantA.id, v1.id, {}, { asChangeOrder: true })).toThrow(
        /change order can only be added to an approved estimate/
      );
    });

    test('a change order on an approved estimate keeps the original marked "approved", not "superseded"', () => {
      const v1 = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id });
      EstimateRepository.approve(tenantA.id, v1.id, { approvedByName: 'Jane' });

      const co = EstimateRepository.createRevision(tenantA.id, v1.id, { title: 'Added scope' }, { asChangeOrder: true });

      expect(co.isChangeOrder).toBe(true);
      expect(co.status).toBe('draft');

      const v1Reloaded = EstimateRepository.findById(tenantA.id, v1.id);
      expect(v1Reloaded.status).toBe('approved'); // preserved -- historical record of what was actually approved
      expect(v1Reloaded.supersededBy).toBe(co.id);
    });

    test('cannot revise a version that has already been superseded', () => {
      const v1 = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id });
      EstimateRepository.createRevision(tenantA.id, v1.id, {});
      expect(() => EstimateRepository.createRevision(tenantA.id, v1.id, {})).toThrow(/already been superseded/);
    });

    test('generates a fresh share token per version', () => {
      const v1 = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id });
      const v2 = EstimateRepository.createRevision(tenantA.id, v1.id, {});
      expect(v2.shareToken).not.toBe(v1.shareToken);
      expect(EstimateRepository.findByShareToken(v1.shareToken).id).toBe(v1.id); // old link still resolves to v1's (now superseded) data
    });

    test('listVersions returns the full chain oldest-first', () => {
      const v1 = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id });
      const v2 = EstimateRepository.createRevision(tenantA.id, v1.id, {});
      const v3 = EstimateRepository.createRevision(tenantA.id, v2.id, {});

      const versions = EstimateRepository.listVersions(tenantA.id, v1.rootEstimateId);
      expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
      expect(versions.map((v) => v.id)).toEqual([v1.id, v2.id, v3.id]);
    });
  });

  describe('delete', () => {
    test('deletes a never-sent draft', () => {
      const estimate = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id });
      expect(EstimateRepository.delete(tenantA.id, estimate.id)).toBe(true);
      expect(EstimateRepository.findById(tenantA.id, estimate.id)).toBeNull();
    });

    test('refuses to delete a non-draft estimate (business record)', () => {
      const estimate = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id });
      EstimateRepository.markSent(tenantA.id, estimate.id);
      expect(() => EstimateRepository.delete(tenantA.id, estimate.id)).toThrow(/Cannot delete/);
    });

    test('also removes the share-token index entry', () => {
      const estimate = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id });
      const token = estimate.shareToken;
      EstimateRepository.delete(tenantA.id, estimate.id);
      expect(EstimateRepository.findByShareToken(token)).toBeNull();
    });
  });

  describe('cascade helpers', () => {
    test('deleteAllForJob removes every version regardless of status', () => {
      const v1 = EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id });
      EstimateRepository.approve(tenantA.id, v1.id, {});

      const count = EstimateRepository.deleteAllForJob(tenantA.id, job.id);
      expect(count).toBe(1);
      expect(EstimateRepository.listByJob(tenantA.id, job.id)).toHaveLength(0);
    });

    test('deleteAllForTenant removes only that tenant\'s estimates', () => {
      const customerB = CustomerRepository.create({ tenantId: tenantB.id, name: 'Other' });
      const jobB = JobRepository.create({ tenantId: tenantB.id, customerId: customerB.id, title: 'Other job' });
      EstimateRepository.create({ tenantId: tenantA.id, jobId: job.id });
      EstimateRepository.create({ tenantId: tenantB.id, jobId: jobB.id });

      const count = EstimateRepository.deleteAllForTenant(tenantA.id);
      expect(count).toBe(1);
      expect(EstimateRepository.listByTenant(tenantA.id)).toHaveLength(0);
      expect(EstimateRepository.listByTenant(tenantB.id)).toHaveLength(1);
    });
  });
});
