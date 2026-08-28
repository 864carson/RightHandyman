require('../helpers/setup');
const request = require('supertest');
const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const UserRepository = require('../../src/models/User');
const CustomerRepository = require('../../src/models/Customer');
const OpportunityRepository = require('../../src/models/Opportunity');
const JobRepository = require('../../src/models/Job');
const EstimateRepository = require('../../src/models/Estimate');
const EstimateTemplateRepository = require('../../src/models/EstimateTemplate');
const CatalogItemRepository = require('../../src/models/CatalogItem');
const { signToken } = require('../../src/utils/jwt');
const createApp = require('../../src/app');

const app = createApp();

describe('Job + Estimate routes', () => {
  let tenant;
  let owner;
  let admin;
  let member;
  let ownerToken;
  let adminToken;
  let memberToken;
  let customer;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme Inc', slug: 'acme' });
    owner = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-1', email: 'owner@example.com', role: 'owner' });
    admin = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-2', email: 'admin@example.com', role: 'admin' });
    member = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-3', email: 'member@example.com', role: 'member' });
    ownerToken = signToken({ userId: owner.id, tenantId: tenant.id });
    adminToken = signToken({ userId: admin.id, tenantId: tenant.id });
    memberToken = signToken({ userId: member.id, tenantId: tenant.id });
    customer = CustomerRepository.create({ tenantId: tenant.id, name: 'Jane Homeowner' });
  });

  describe('POST /jobs', () => {
    test('member can create a job (jobs:create is granted by default)', async () => {
      const res = await request(app)
        .post('/jobs')
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ customerId: customer.id, title: 'Backyard drainage' });

      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Backyard drainage');
      expect(res.body.status).toBe('estimating');
      expect(res.body.createdBy).toBe(member.id);
    });

    test('rejects an unknown customerId', async () => {
      const res = await request(app)
        .post('/jobs')
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ customerId: 'ghost', title: 'Job' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /jobs, /jobs/:id, /jobs/:id/estimates', () => {
    test('lists jobs, optionally filtered by customer, and fetches one', async () => {
      const job = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'Job 1' });

      const list = await request(app).get('/jobs').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`);
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);

      const filtered = await request(app)
        .get(`/jobs?customerId=${customer.id}`)
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`);
      expect(filtered.body).toHaveLength(1);

      const single = await request(app).get(`/jobs/${job.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`);
      expect(single.status).toBe(200);
      expect(single.body.id).toBe(job.id);
    });

    test('GET /jobs/:id/estimates returns every version with full internal detail', async () => {
      const job = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'Job 1' });
      EstimateRepository.create({
        tenantId: tenant.id,
        jobId: job.id,
        lineItems: [{ description: 'Mulch', category: 'materials', unit: 'yard', quantity: 2, unitCost: 28, markupType: 'percent', markupValue: 30 }]
      });

      const res = await request(app).get(`/jobs/${job.id}/estimates`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].totals.totalPrice).toBeGreaterThan(0);
      expect(res.body[0].lineItems[0].cost).toBeDefined(); // internal view leaks cost, as intended for staff
    });

    test('404 for an unknown job', async () => {
      const res = await request(app).get('/jobs/ghost').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH / DELETE /jobs/:id', () => {
    test('member can update job fields including weather flags', async () => {
      const job = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'Exterior paint' });

      const res = await request(app)
        .patch(`/jobs/${job.id}`)
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ weatherSensitive: true, weatherNotes: 'Paint only if dry for 48 hrs' });

      expect(res.status).toBe(200);
      expect(res.body.weatherSensitive).toBe(true);
    });

    test('DELETE /jobs/:id is blocked for member by default', async () => {
      const job = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'Job' });
      const res = await request(app).delete(`/jobs/${job.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(403);
    });

    test('DELETE /jobs/:id works for admin and cascades to its estimates', async () => {
      const job = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'Job' });
      EstimateRepository.create({ tenantId: tenant.id, jobId: job.id });

      const res = await request(app).delete(`/jobs/${job.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(204);
      expect(JobRepository.findById(tenant.id, job.id)).toBeNull();
      expect(EstimateRepository.listByJob(tenant.id, job.id)).toHaveLength(0);
    });
  });

  describe('Estimate lifecycle', () => {
    let job;

    beforeEach(() => {
      job = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'Mulch bed refresh' });
    });

    test('POST /estimates creates a draft and points the job at it', async () => {
      const res = await request(app)
        .post('/estimates')
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          jobId: job.id,
          title: 'Mulch refresh estimate',
          lineItems: [{ description: 'Mulch', category: 'materials', unit: 'yard', quantity: 4, unitCost: 28, markupType: 'percent', markupValue: 30 }]
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('draft');
      expect(res.body.totals.totalPrice).toBeGreaterThan(0);
      expect(JobRepository.findById(tenant.id, job.id).currentEstimateId).toBe(res.body.id);
    });

    test('POST /estimates requires a jobId', async () => {
      const res = await request(app).post('/estimates').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({});
      expect(res.status).toBe(400);
    });

    test('POST /estimates/from-template copies the template line items', async () => {
      const template = EstimateTemplateRepository.create({
        tenantId: tenant.id,
        trade: 'landscaping',
        name: 'Mulch bed refresh',
        lineItems: [{ description: 'Mulch', category: 'materials', unit: 'yard', defaultQuantity: 4, defaultUnitCost: 28, markupType: 'percent', markupValue: 30 }]
      });

      const res = await request(app)
        .post('/estimates/from-template')
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ jobId: job.id, templateId: template.id });

      expect(res.status).toBe(201);
      expect(res.body.lineItems).toHaveLength(1);
      expect(res.body.lineItems[0].quantity).toBe(4);
    });

    test('GET /estimates/:id defaults to internal view, ?view=customer sanitizes it', async () => {
      const estimate = EstimateRepository.create({
        tenantId: tenant.id,
        jobId: job.id,
        lineItems: [{ description: 'Mulch', category: 'materials', unit: 'yard', quantity: 4, unitCost: 28, markupType: 'percent', markupValue: 30 }]
      });

      const internal = await request(app).get(`/estimates/${estimate.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`);
      expect(internal.body.lineItems[0].cost).toBeDefined();

      const customerView = await request(app)
        .get(`/estimates/${estimate.id}?view=customer`)
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`);
      expect(customerView.status).toBe(200);
      expect(customerView.body.lineItems[0].cost).toBeUndefined();
      expect(JSON.stringify(customerView.body)).not.toMatch(/markupValue/);
    });

    test('PATCH /estimates/:id edits a draft, but 409s once sent', async () => {
      const estimate = EstimateRepository.create({ tenantId: tenant.id, jobId: job.id, title: 'Original' });

      const edited = await request(app)
        .patch(`/estimates/${estimate.id}`)
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ title: 'Renamed' });
      expect(edited.status).toBe(200);
      expect(edited.body.title).toBe('Renamed');

      await request(app).post(`/estimates/${estimate.id}/send`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`);

      const blocked = await request(app)
        .patch(`/estimates/${estimate.id}`)
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ title: 'Too late' });
      expect(blocked.status).toBe(409);
    });

    test('POST /estimates/:id/send then /approve advances status and job status', async () => {
      const estimate = EstimateRepository.create({ tenantId: tenant.id, jobId: job.id });

      const sent = await request(app).post(`/estimates/${estimate.id}/send`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`);
      expect(sent.status).toBe(200);
      expect(sent.body.status).toBe('sent');

      const approved = await request(app)
        .post(`/estimates/${estimate.id}/approve`)
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ approvedByName: 'Jane Homeowner' });
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe('approved');
      expect(JobRepository.findById(tenant.id, job.id).status).toBe('approved');
    });

    test('POST /estimates/:id/reject records a reason', async () => {
      const estimate = EstimateRepository.create({ tenantId: tenant.id, jobId: job.id });
      const res = await request(app)
        .post(`/estimates/${estimate.id}/reject`)
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ reason: 'Went with another company' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('rejected');
      expect(res.body.rejectionReason).toBe('Went with another company');
    });

    test('POST /estimates/:id/revise creates version 2; asChangeOrder requires an approved parent', async () => {
      const estimate = EstimateRepository.create({ tenantId: tenant.id, jobId: job.id });

      const plainRevision = await request(app)
        .post(`/estimates/${estimate.id}/revise`)
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ title: 'Revised scope' });
      expect(plainRevision.status).toBe(201);
      expect(plainRevision.body.version).toBe(2);
      expect(plainRevision.body.isChangeOrder).toBe(false);

      const blockedChangeOrder = await request(app)
        .post(`/estimates/${plainRevision.body.id}/revise`)
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ asChangeOrder: true });
      expect(blockedChangeOrder.status).toBe(409);

      await request(app)
        .post(`/estimates/${plainRevision.body.id}/approve`)
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({});

      const changeOrder = await request(app)
        .post(`/estimates/${plainRevision.body.id}/revise`)
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ asChangeOrder: true, title: 'Added scope after approval' });
      expect(changeOrder.status).toBe(201);
      expect(changeOrder.body.isChangeOrder).toBe(true);

      // The version that was actually approved keeps saying so.
      const approvedVersionStillApproved = await request(app)
        .get(`/estimates/${plainRevision.body.id}`)
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`);
      expect(approvedVersionStillApproved.body.status).toBe('approved');
    });

    test('GET /estimates/:id/versions returns the full chain', async () => {
      const v1 = EstimateRepository.create({ tenantId: tenant.id, jobId: job.id });
      const v2 = EstimateRepository.createRevision(tenant.id, v1.id, {});

      const res = await request(app).get(`/estimates/${v2.id}/versions`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(200);
      expect(res.body.map((v) => v.version)).toEqual([1, 2]);
    });

    test('DELETE /estimates/:id works on a draft but is blocked for member, 409s once sent', async () => {
      const estimate = EstimateRepository.create({ tenantId: tenant.id, jobId: job.id });

      const forbidden = await request(app).delete(`/estimates/${estimate.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`);
      expect(forbidden.status).toBe(403); // member does not have estimates:delete by default

      const ok = await request(app).delete(`/estimates/${estimate.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${adminToken}`);
      expect(ok.status).toBe(204);

      const estimate2 = EstimateRepository.create({ tenantId: tenant.id, jobId: job.id });
      await request(app).post(`/estimates/${estimate2.id}/send`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`);
      const blocked = await request(app).delete(`/estimates/${estimate2.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${adminToken}`);
      expect(blocked.status).toBe(409);
    });
  });

  describe('Opportunity -> Job conversion', () => {
    test('POST /opportunities/:id/convert-to-job marks the opportunity won and creates a linked job', async () => {
      const opp = OpportunityRepository.create({ tenantId: tenant.id, customerId: customer.id, name: 'Drainage bid', stage: 'proposal' });

      const res = await request(app)
        .post(`/opportunities/${opp.id}/convert-to-job`)
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ siteAddress: '123 Elm St' });

      expect(res.status).toBe(201);
      expect(res.body.opportunityId).toBe(opp.id);
      expect(res.body.customerId).toBe(customer.id);
      expect(OpportunityRepository.findById(tenant.id, opp.id).stage).toBe('won');
    });

    test('404s for an unknown opportunity', async () => {
      const res = await request(app)
        .post('/opportunities/ghost/convert-to-job')
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({});
      expect(res.status).toBe(404);
    });
  });

  describe('Catalog item routes', () => {
    test('member can read but not manage the catalog', async () => {
      const listRes = await request(app).get('/catalog-items').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`);
      expect(listRes.status).toBe(200);

      const createRes = await request(app)
        .post('/catalog-items')
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ trade: 'landscaping', name: 'Mulch', unit: 'yard' });
      expect(createRes.status).toBe(403);
    });

    test('admin can create, update, and (soft) delete a catalog item', async () => {
      const created = await request(app)
        .post('/catalog-items')
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ trade: 'landscaping', category: 'materials', name: 'Mulch, bulk yard', unit: 'yard', defaultUnitCost: 28 });
      expect(created.status).toBe(201);
      expect(created.body.defaultMarkupValue).toBe(30); // default materials markup

      const updated = await request(app)
        .patch(`/catalog-items/${created.body.id}`)
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ defaultUnitCost: 32 });
      expect(updated.status).toBe(200);
      expect(updated.body.defaultUnitCost).toBe(32);

      const deleted = await request(app).delete(`/catalog-items/${created.body.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${adminToken}`);
      expect(deleted.status).toBe(204);
      expect(CatalogItemRepository.findById(tenant.id, created.body.id).active).toBe(false);
    });

    test('POST /catalog-items/seed-defaults loads the starter catalog and templates', async () => {
      const res = await request(app).post('/catalog-items/seed-defaults').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(201);
      expect(res.body.catalogItems.length).toBeGreaterThan(10);
      expect(res.body.templates.length).toBeGreaterThan(0);
      expect(CatalogItemRepository.listByTenant(tenant.id).length).toBe(res.body.catalogItems.length);
    });
  });

  describe('Estimate template routes', () => {
    test('admin can create a template; member can read it', async () => {
      const created = await request(app)
        .post('/estimate-templates')
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          trade: 'drainage',
          name: 'French drain, 50ft',
          lineItems: [{ description: 'Pipe', category: 'materials', unit: 'linear foot', defaultQuantity: 50, defaultUnitCost: 1.8 }]
        });
      expect(created.status).toBe(201);

      const listed = await request(app).get('/estimate-templates').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`);
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);
    });

    test('rejects a template with empty lineItems', async () => {
      const res = await request(app)
        .post('/estimate-templates')
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ trade: 'drainage', name: 'Bad template', lineItems: [] });
      expect(res.status).toBe(400);
    });
  });

  describe('Customer deletion cascades to jobs and estimates', () => {
    test('DELETE /customers/:id removes the customer\'s jobs and every estimate version under them', async () => {
      const job = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'Job' });
      EstimateRepository.create({ tenantId: tenant.id, jobId: job.id });

      const res = await request(app).delete(`/customers/${customer.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(204);
      expect(JobRepository.listByCustomer(tenant.id, customer.id)).toHaveLength(0);
      expect(EstimateRepository.listByJob(tenant.id, job.id)).toHaveLength(0);
    });
  });

  describe('Tenant deletion cascades to jobs, estimates, catalog, and templates', () => {
    test('DELETE /tenants/:idOrSlug removes every estimating-related record', async () => {
      const job = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'Job' });
      EstimateRepository.create({ tenantId: tenant.id, jobId: job.id });
      CatalogItemRepository.create({ tenantId: tenant.id, trade: 'landscaping', name: 'Mulch', unit: 'yard' });
      EstimateTemplateRepository.create({
        tenantId: tenant.id,
        trade: 'landscaping',
        name: 'Mow + edge',
        lineItems: [{ description: 'Mow', unit: 'visit', defaultQuantity: 1 }]
      });

      const res = await request(app).delete('/tenants/acme').set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(204);
      expect(JobRepository.listByTenant(tenant.id)).toHaveLength(0);
      expect(EstimateRepository.listByTenant(tenant.id)).toHaveLength(0);
      expect(CatalogItemRepository.listByTenant(tenant.id, { includeInactive: true })).toHaveLength(0);
      expect(EstimateTemplateRepository.listByTenant(tenant.id, { includeInactive: true })).toHaveLength(0);
    });
  });
});

describe('Public (unauthenticated) customer-facing estimate routes', () => {
  let tenant;
  let customer;
  let job;
  let estimate;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme Inc', slug: 'acme' });
    customer = CustomerRepository.create({ tenantId: tenant.id, name: 'Jane Homeowner' });
    job = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'Mulch bed refresh' });
    estimate = EstimateRepository.create({
      tenantId: tenant.id,
      jobId: job.id,
      title: 'Mulch bed refresh estimate',
      lineItems: [{ description: 'Mulch', category: 'materials', unit: 'yard', quantity: 4, unitCost: 28, markupType: 'percent', markupValue: 30 }]
    });
  });

  test('GET /public/estimates/:shareToken requires no auth or tenant header and returns the sanitized view', async () => {
    const res = await request(app).get(`/public/estimates/${estimate.shareToken}`);

    expect(res.status).toBe(200);
    expect(res.body.lineItems[0].cost).toBeUndefined();
    expect(res.body.totalPrice).toBeGreaterThan(0);
  });

  test('GET /public/estimates/:shareToken 404s for an unknown token', async () => {
    const res = await request(app).get('/public/estimates/not-a-real-token');
    expect(res.status).toBe(404);
  });

  test('POST /public/estimates/:shareToken/approve records approval and flips job status, with no auth', async () => {
    const res = await request(app).post(`/public/estimates/${estimate.shareToken}/approve`).send({ approvedByName: 'Jane Homeowner' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(EstimateRepository.findById(tenant.id, estimate.id).approvedBy.name).toBe('Jane Homeowner');
    expect(JobRepository.findById(tenant.id, job.id).status).toBe('approved');
  });

  test('POST /public/estimates/:shareToken/reject records a reason, with no auth', async () => {
    const res = await request(app).post(`/public/estimates/${estimate.shareToken}/reject`).send({ reason: 'Too expensive' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
  });

  test('approve returns 410 once the estimate is past its validity window', async () => {
    const expiring = EstimateRepository.create({ tenantId: tenant.id, jobId: job.id, validDays: -1 }); // already in the past

    const res = await request(app).post(`/public/estimates/${expiring.shareToken}/approve`).send({});
    expect(res.status).toBe(410);
  });

  test('the public view never includes cost, markup, or margin anywhere in the payload', async () => {
    const res = await request(app).get(`/public/estimates/${estimate.shareToken}`);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/markupValue/);
    expect(serialized).not.toMatch(/markupAmount/);
    expect(serialized).not.toMatch(/marginPercent/);
    expect(serialized).not.toMatch(/unitCost/);
  });
});
