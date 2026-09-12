require('../helpers/setup');
const request = require('supertest');
const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const UserRepository = require('../../src/models/User');
const CustomerRepository = require('../../src/models/Customer');
const JobRepository = require('../../src/models/Job');
const EstimateRepository = require('../../src/models/Estimate');
const TimeEntryRepository = require('../../src/models/TimeEntry');
const { signToken } = require('../../src/utils/jwt');
const createApp = require('../../src/app');

const app = createApp();

describe('Time tracking routes', () => {
  let tenant;
  let owner;
  let ownerToken;
  let member;
  let memberToken;
  let member2;
  let member2Token;
  let customer;
  let job;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme Landscaping', slug: 'acme' });
    owner = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-owner', email: 'owner@example.com', role: 'owner' });
    member = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-mem', email: 'crew@example.com', role: 'member' });
    member2 = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-mem2', email: 'crew2@example.com', role: 'member' });
    ownerToken = signToken({ userId: owner.id, tenantId: tenant.id });
    memberToken = signToken({ userId: member.id, tenantId: tenant.id });
    member2Token = signToken({ userId: member2.id, tenantId: tenant.id });
    customer = CustomerRepository.create({ tenantId: tenant.id, name: 'Jane Homeowner' });
    job = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'Mulch bed refresh' });
  });

  describe('Self clock-in / clock-out', () => {
    test('a member can clock themselves in and out', async () => {
      const clockIn = await request(app).post('/time-entries/clock-in').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({ jobId: job.id, notes: 'starting' });
      expect(clockIn.status).toBe(201);
      expect(clockIn.body.status).toBe('active');
      expect(clockIn.body.entryMethod).toBe('self_clock');

      const clockOut = await request(app).post('/time-entries/clock-out').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({ notes: 'done' });
      expect(clockOut.status).toBe(200);
      expect(clockOut.body.status).toBe('completed');
      expect(clockOut.body.durationMinutes).toBeGreaterThanOrEqual(0);
    });

    test('clock-in requires a jobId', async () => {
      const res = await request(app).post('/time-entries/clock-in').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({});
      expect(res.status).toBe(400);
    });

    test('cannot clock in twice without clocking out', async () => {
      await request(app).post('/time-entries/clock-in').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({ jobId: job.id });
      const second = await request(app).post('/time-entries/clock-in').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({ jobId: job.id });
      expect(second.status).toBe(409);
    });

    test('clock-out with nothing active is a 409', async () => {
      const res = await request(app).post('/time-entries/clock-out').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({});
      expect(res.status).toBe(409);
    });

    test('own clock-in snapshots the caller\'s own default rates', async () => {
      await request(app).patch(`/users/${member.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`).send({ defaultHourlyCost: 22, defaultBillingRate: 65 });

      const res = await request(app).post('/time-entries/clock-in').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({ jobId: job.id });
      expect(res.body.hourlyCost).toBe(22);
      expect(res.body.billingRate).toBe(65);
    });

    test('GET /time-entries/mine returns only the caller\'s own history', async () => {
      TimeEntryRepository.createManual({ tenantId: tenant.id, jobId: job.id, userId: member.id, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });
      TimeEntryRepository.createManual({ tenantId: tenant.id, jobId: job.id, userId: member2.id, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });

      const res = await request(app).get('/time-entries/mine').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].userId).toBe(member.id);
    });
  });

  describe('Only an employee themselves can be clocked in as, not on behalf of someone else', () => {
    test('a plain member cannot read another employee\'s time entry directly (time-entries:read is admin+)', async () => {
      const entry = TimeEntryRepository.createManual({ tenantId: tenant.id, jobId: job.id, userId: member2.id, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });
      const res = await request(app).get(`/time-entries/${entry.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(403);
    });

    test('an owner can read any entry', async () => {
      const entry = TimeEntryRepository.createManual({ tenantId: tenant.id, jobId: job.id, userId: member2.id, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });
      const res = await request(app).get(`/time-entries/${entry.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
    });
  });

  describe('Manual entry, force-clock-out, edit, delete (manager-only)', () => {
    test('a member cannot create a manual entry on behalf of someone else', async () => {
      const res = await request(app)
        .post(`/jobs/${job.id}/time-entries`)
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ userId: member2.id, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });
      expect(res.status).toBe(403);
    });

    test('an owner can create a manual entry on behalf of an employee', async () => {
      const res = await request(app)
        .post(`/jobs/${job.id}/time-entries`)
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ userId: member.id, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T12:30:00Z', notes: 'timesheet' });
      expect(res.status).toBe(201);
      expect(res.body.durationMinutes).toBe(270);
      expect(res.body.entryMethod).toBe('manual');
    });

    test('owner can force-clock-out a forgotten active entry', async () => {
      await request(app).post('/time-entries/clock-in').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({ jobId: job.id });
      const active = TimeEntryRepository.findActiveForUser(tenant.id, member.id);

      const res = await request(app)
        .post(`/time-entries/${active.id}/force-clock-out`)
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ notes: 'forgot to clock out' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
    });

    test('owner can edit and delete an entry; member cannot', async () => {
      const entry = TimeEntryRepository.createManual({ tenantId: tenant.id, jobId: job.id, userId: member.id, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });

      const memberEdit = await request(app).patch(`/time-entries/${entry.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({ notes: 'x' });
      expect(memberEdit.status).toBe(403);

      const ownerEdit = await request(app).patch(`/time-entries/${entry.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`).send({ notes: 'corrected' });
      expect(ownerEdit.status).toBe(200);
      expect(ownerEdit.body.notes).toBe('corrected');

      const memberDelete = await request(app).delete(`/time-entries/${entry.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`);
      expect(memberDelete.status).toBe(403);

      const ownerDelete = await request(app).delete(`/time-entries/${entry.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`);
      expect(ownerDelete.status).toBe(204);
    });
  });

  describe('Job time-entries list and pricing summary', () => {
    beforeEach(() => {
      TimeEntryRepository.createManual({ tenantId: tenant.id, jobId: job.id, userId: member.id, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T14:00:00Z', hourlyCost: 22, billingRate: 65 });
    });

    test('GET /jobs/:id/time-entries requires time-entries:read (admin+), not just any member', async () => {
      const memberRes = await request(app).get(`/jobs/${job.id}/time-entries`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`);
      expect(memberRes.status).toBe(403);

      const ownerRes = await request(app).get(`/jobs/${job.id}/time-entries`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`);
      expect(ownerRes.status).toBe(200);
      expect(ownerRes.body).toHaveLength(1);
    });

    test('GET /jobs/:id/time-summary reflects quoted vs actual for a fixed-price job', async () => {
      const estimate = EstimateRepository.create({
        tenantId: tenant.id,
        jobId: job.id,
        lineItems: [{ description: 'Labor', category: 'labor', unit: 'hour', quantity: 4, unitCost: 25, markupType: 'percent', markupValue: 50 }]
      });
      JobRepository.setCurrentEstimate(tenant.id, job.id, estimate.id);

      const res = await request(app).get(`/jobs/${job.id}/time-summary`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.quoted.laborHours).toBe(4);
      expect(res.body.actual.totalHours).toBe(6);
      expect(res.body.variance.laborHours).toBe(2);
      expect(res.body.pricingModel).toBe('fixed');
    });
  });

  describe('POST /jobs/:id/finalize-pricing', () => {
    test('locks time entries and stamps the job as finalized', async () => {
      TimeEntryRepository.createManual({ tenantId: tenant.id, jobId: job.id, userId: member.id, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });

      const res = await request(app).post(`/jobs/${job.id}/finalize-pricing`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.finalizedAt).toBeDefined();
      expect(res.body.finalPriceSnapshot).toBeDefined();

      const stillEditable = await request(app)
        .post(`/jobs/${job.id}/time-entries`)
        .set('x-tenant-id', 'acme')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ userId: member.id, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });
      expect(stillEditable.status).toBe(409);
    });

    test('refuses while someone is still clocked in', async () => {
      await request(app).post('/time-entries/clock-in').set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({ jobId: job.id });
      const res = await request(app).post(`/jobs/${job.id}/finalize-pricing`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(409);
    });

    test('a member cannot finalize pricing (time-entries:manage is admin+)', async () => {
      const res = await request(app).post(`/jobs/${job.id}/finalize-pricing`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(403);
    });

    test('time_and_materials job final price genuinely differs from the original quote after an overrun', async () => {
      const tmJob = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'T&M drainage', pricingModel: 'time_and_materials' });
      const estimate = EstimateRepository.create({
        tenantId: tenant.id,
        jobId: tmJob.id,
        lineItems: [{ description: 'Labor', category: 'labor', unit: 'hour', quantity: 2, unitCost: 25, markupType: 'percent', markupValue: 50 }]
      });
      JobRepository.setCurrentEstimate(tenant.id, tmJob.id, estimate.id);
      TimeEntryRepository.createManual({ tenantId: tenant.id, jobId: tmJob.id, userId: member.id, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T14:00:00Z', hourlyCost: 22, billingRate: 65 });

      const res = await request(app).post(`/jobs/${tmJob.id}/finalize-pricing`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.finalPriceSnapshot.finalPrice).toBeGreaterThan(res.body.finalPriceSnapshot.quoted.totalPrice);
    });
  });

  describe('Cascade deletes', () => {
    test('deleting a job removes its time entries', async () => {
      TimeEntryRepository.createManual({ tenantId: tenant.id, jobId: job.id, userId: member.id, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });

      const res = await request(app).delete(`/jobs/${job.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(204);
      expect(TimeEntryRepository.listByJob(tenant.id, job.id)).toHaveLength(0);
    });

    test('deleting a customer removes time entries under all of their jobs', async () => {
      TimeEntryRepository.createManual({ tenantId: tenant.id, jobId: job.id, userId: member.id, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });

      const res = await request(app).delete(`/customers/${customer.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(204);
      expect(TimeEntryRepository.listByJob(tenant.id, job.id)).toHaveLength(0);
    });
  });

  describe('User rate fields', () => {
    test('a member cannot set their own or anyone\'s pay/billing rate', async () => {
      const res = await request(app).patch(`/users/${member.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${memberToken}`).send({ defaultHourlyCost: 999 });
      expect(res.status).toBe(403);
    });

    test('an owner can set an employee\'s rates', async () => {
      const res = await request(app).patch(`/users/${member.id}`).set('x-tenant-id', 'acme').set('Authorization', `Bearer ${ownerToken}`).send({ defaultHourlyCost: 24, defaultBillingRate: 70 });
      expect(res.status).toBe(200);
      expect(res.body.defaultHourlyCost).toBe(24);
      expect(res.body.defaultBillingRate).toBe(70);
    });
  });
});
