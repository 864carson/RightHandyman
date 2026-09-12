const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const CustomerRepository = require('../../src/models/Customer');
const JobRepository = require('../../src/models/Job');
const EstimateRepository = require('../../src/models/Estimate');
const EstimateAcceptanceRepository = require('../../src/models/EstimateAcceptance');
const { hashToken } = require('../../src/utils/tokenHash');
const estimateController = require('../../src/controllers/estimateController');

describe('Estimate share tokens are hashed at rest', () => {
  let tenant;
  let job;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme', slug: 'acme' });
    const customer = CustomerRepository.create({ tenantId: tenant.id, name: 'Jane' });
    job = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'Job' });
  });

  test('create() returns the raw token once, but never persists it', () => {
    const estimate = EstimateRepository.create({ tenantId: tenant.id, jobId: job.id });

    expect(estimate.shareToken).toBeDefined();
    expect(estimate.shareTokenHash).toBe(hashToken(estimate.shareToken));

    const refetched = EstimateRepository.findById(tenant.id, estimate.id);
    expect(refetched.shareToken).toBeUndefined();
    expect(refetched.shareTokenHash).toBe(estimate.shareTokenHash);
  });

  test('findByShareToken accepts the raw token and hashes it internally', () => {
    const estimate = EstimateRepository.create({ tenantId: tenant.id, jobId: job.id });
    expect(EstimateRepository.findByShareToken(estimate.shareToken).id).toBe(estimate.id);
    expect(EstimateRepository.findByShareToken('not-the-real-token')).toBeNull();
  });

  test('the hash itself does not work as a lookup token', () => {
    const estimate = EstimateRepository.create({ tenantId: tenant.id, jobId: job.id });
    expect(EstimateRepository.findByShareToken(estimate.shareTokenHash)).toBeNull();
  });

  test('createRevision issues a fresh token; the old one still resolves to the old (now superseded/approved) version', () => {
    const v1 = EstimateRepository.create({ tenantId: tenant.id, jobId: job.id });
    const v2 = EstimateRepository.createRevision(tenant.id, v1.id, {});

    expect(v2.shareToken).not.toBe(v1.shareToken);
    expect(EstimateRepository.findByShareToken(v1.shareToken).id).toBe(v1.id);
    expect(EstimateRepository.findByShareToken(v2.shareToken).id).toBe(v2.id);
  });

  test('delete() removes the hash index entry along with the estimate', () => {
    const estimate = EstimateRepository.create({ tenantId: tenant.id, jobId: job.id });
    const token = estimate.shareToken;
    EstimateRepository.delete(tenant.id, estimate.id);
    expect(EstimateRepository.findByShareToken(token)).toBeNull();
  });
});

describe('Estimate.recordView', () => {
  let tenant;
  let estimate;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme', slug: 'acme' });
    const customer = CustomerRepository.create({ tenantId: tenant.id, name: 'Jane' });
    const job = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'Job' });
    estimate = EstimateRepository.create({ tenantId: tenant.id, jobId: job.id });
  });

  test('sets viewedAt on first call, increments viewCount every call, never overwrites viewedAt', () => {
    expect(estimate.viewedAt).toBeNull();
    expect(estimate.viewCount).toBe(0);

    EstimateRepository.recordView(tenant.id, estimate.id);
    const afterFirst = EstimateRepository.findById(tenant.id, estimate.id);
    expect(afterFirst.viewCount).toBe(1);
    expect(afterFirst.viewedAt).toBeDefined();

    const firstViewedAt = afterFirst.viewedAt;
    EstimateRepository.recordView(tenant.id, estimate.id);
    const afterSecond = EstimateRepository.findById(tenant.id, estimate.id);
    expect(afterSecond.viewCount).toBe(2);
    expect(afterSecond.viewedAt).toBe(firstViewedAt);
  });

  test('returns null for an unknown estimate or wrong tenant', () => {
    expect(EstimateRepository.recordView(tenant.id, 'ghost')).toBeNull();
    expect(EstimateRepository.recordView('other-tenant', estimate.id)).toBeNull();
  });
});

describe('Estimate.regenerateShareLink', () => {
  let tenant;
  let estimate;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme', slug: 'acme' });
    const customer = CustomerRepository.create({ tenantId: tenant.id, name: 'Jane' });
    const job = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'Job' });
    estimate = EstimateRepository.create({ tenantId: tenant.id, jobId: job.id });
  });

  test('issues a new token and immediately retires the old one', () => {
    const oldToken = estimate.shareToken;
    const regenerated = EstimateRepository.regenerateShareLink(tenant.id, estimate.id);

    expect(regenerated.shareToken).toBeDefined();
    expect(regenerated.shareToken).not.toBe(oldToken);
    expect(EstimateRepository.findByShareToken(oldToken)).toBeNull();
    expect(EstimateRepository.findByShareToken(regenerated.shareToken).id).toBe(estimate.id);
  });

  test('works in any status and never changes approval state', () => {
    EstimateRepository.approve(tenant.id, estimate.id, {});
    const regenerated = EstimateRepository.regenerateShareLink(tenant.id, estimate.id);
    expect(regenerated.status).toBe('approved');
  });

  test('returns null for an unknown estimate or wrong tenant', () => {
    expect(EstimateRepository.regenerateShareLink(tenant.id, 'ghost')).toBeNull();
    expect(EstimateRepository.regenerateShareLink('other-tenant', estimate.id)).toBeNull();
  });
});

describe('Estimate.approve / reject capture email and rejectedBy', () => {
  let tenant;
  let job;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme', slug: 'acme' });
    const customer = CustomerRepository.create({ tenantId: tenant.id, name: 'Jane' });
    job = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'Job' });
  });

  test('approve captures approvedByEmail alongside name', () => {
    const estimate = EstimateRepository.create({ tenantId: tenant.id, jobId: job.id });
    const approved = EstimateRepository.approve(tenant.id, estimate.id, { approvedByName: 'Jane', approvedByEmail: 'jane@example.com' });
    expect(approved.approvedBy).toEqual({ name: 'Jane', email: 'jane@example.com', signatureText: null });
  });

  test('reject captures a rejectedBy name/email, symmetric with approve', () => {
    const estimate = EstimateRepository.create({ tenantId: tenant.id, jobId: job.id });
    const rejected = EstimateRepository.reject(tenant.id, estimate.id, { reason: 'too pricey', rejectedByName: 'Bob', rejectedByEmail: 'bob@example.com' });
    expect(rejected.rejectedBy).toEqual({ name: 'Bob', email: 'bob@example.com' });
    expect(rejected.rejectionReason).toBe('too pricey');
  });
});

describe('estimateController.buildInternalView shareUrl', () => {
  let tenant;
  let job;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme', slug: 'acme' });
    const customer = CustomerRepository.create({ tenantId: tenant.id, name: 'Jane' });
    job = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'Job' });
    delete process.env.PUBLIC_APP_URL;
  });

  afterEach(() => {
    delete process.env.PUBLIC_APP_URL;
  });

  test('is null without PUBLIC_APP_URL configured', () => {
    const estimate = estimateController.createEstimate(tenant.id, { jobId: job.id });
    expect(estimateController.buildInternalView(estimate).shareUrl).toBeNull();
  });

  test('is a full clickable link when PUBLIC_APP_URL is set and the raw token is present', () => {
    process.env.PUBLIC_APP_URL = 'https://app.example.com';
    const estimate = estimateController.createEstimate(tenant.id, { jobId: job.id });
    const view = estimateController.buildInternalView(estimate);
    expect(view.shareUrl).toBe(`https://app.example.com/public/estimates/${estimate.shareToken}`);
  });

  test('trims a trailing slash on PUBLIC_APP_URL', () => {
    process.env.PUBLIC_APP_URL = 'https://app.example.com/';
    const estimate = estimateController.createEstimate(tenant.id, { jobId: job.id });
    expect(estimateController.buildInternalView(estimate).shareUrl).toBe(`https://app.example.com/public/estimates/${estimate.shareToken}`);
  });

  test('is null on a re-fetched estimate even with PUBLIC_APP_URL set -- the raw token only exists once', () => {
    process.env.PUBLIC_APP_URL = 'https://app.example.com';
    const estimate = estimateController.createEstimate(tenant.id, { jobId: job.id });
    const refetched = EstimateRepository.findById(tenant.id, estimate.id);
    expect(estimateController.buildInternalView(refetched).shareUrl).toBeNull();
  });
});

describe('estimateController.recordAcceptanceEvent', () => {
  let tenant;
  let job;
  let estimate;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme', slug: 'acme' });
    const customer = CustomerRepository.create({ tenantId: tenant.id, name: 'Jane' });
    job = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'Job' });
    estimate = estimateController.createEstimate(tenant.id, { jobId: job.id });
  });

  test('throws 404 for an unknown estimate', () => {
    expect.assertions(1);
    try {
      estimateController.recordAcceptanceEvent(tenant.id, 'ghost', { action: 'accepted', name: 'Jane' });
    } catch (err) {
      expect(err.status).toBe(404);
    }
  });

  test('first accept: not idempotent, writes exactly one ledger entry, approves the estimate', () => {
    const result = estimateController.recordAcceptanceEvent(tenant.id, estimate.id, {
      action: 'accepted',
      name: 'Jane Homeowner',
      email: 'jane@example.com',
      ipAddress: '203.0.113.5',
      userAgent: 'Mozilla/5.0',
      tokenLast8: 'abcd1234'
    });

    expect(result.idempotent).toBe(false);
    expect(result.estimate.status).toBe('approved');
    expect(result.acceptance.name).toBe('Jane Homeowner');
    expect(EstimateAcceptanceRepository.listForEstimate(tenant.id, estimate.id)).toHaveLength(1);
  });

  test('a repeated accept is idempotent: same acceptance record, no duplicate ledger entry', () => {
    const first = estimateController.recordAcceptanceEvent(tenant.id, estimate.id, { action: 'accepted', name: 'Jane' });
    const second = estimateController.recordAcceptanceEvent(tenant.id, estimate.id, { action: 'accepted', name: 'Jane' });

    expect(second.idempotent).toBe(true);
    expect(second.acceptance.id).toBe(first.acceptance.id);
    expect(EstimateAcceptanceRepository.listForEstimate(tenant.id, estimate.id)).toHaveLength(1);
  });

  test('a conflicting action (reject something already accepted) still throws 409, is not idempotent', () => {
    estimateController.recordAcceptanceEvent(tenant.id, estimate.id, { action: 'accepted', name: 'Jane' });

    expect.assertions(1);
    try {
      estimateController.recordAcceptanceEvent(tenant.id, estimate.id, { action: 'rejected', name: 'Jane' });
    } catch (err) {
      expect(err.status).toBe(409);
    }
  });

  test('reject records to the ledger and rejects the estimate', () => {
    const result = estimateController.recordAcceptanceEvent(tenant.id, estimate.id, {
      action: 'rejected',
      name: 'Bob',
      reason: 'too expensive'
    });

    expect(result.idempotent).toBe(false);
    expect(result.estimate.status).toBe('rejected');
    expect(result.acceptance.reason).toBe('too expensive');
  });

  test('two "simultaneous" accept requests (Promise.all) still produce exactly one ledger entry', async () => {
    // This app's store is synchronous in-memory JS -- there's no real I/O
    // yield point inside the check-then-set critical section, so Node's
    // single-threaded event loop processes these strictly one at a time
    // even when kicked off "concurrently" from the caller's perspective.
    // This test still meaningfully proves the idempotency guarantee holds
    // under concurrent-looking load; a real async DB-backed store should
    // additionally enforce this with a DB-level unique constraint or a
    // conditional update (see README).
    const payload = { action: 'accepted', name: 'Jane Homeowner' };
    const [first, second] = await Promise.all([
      Promise.resolve(estimateController.recordAcceptanceEvent(tenant.id, estimate.id, payload)),
      Promise.resolve(estimateController.recordAcceptanceEvent(tenant.id, estimate.id, payload))
    ]);

    const results = [first, second];
    expect(results.filter((r) => r.idempotent === false)).toHaveLength(1);
    expect(results.filter((r) => r.idempotent === true)).toHaveLength(1);
    expect(EstimateAcceptanceRepository.listForEstimate(tenant.id, estimate.id)).toHaveLength(1);
  });
});
