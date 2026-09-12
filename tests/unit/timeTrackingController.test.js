const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const UserRepository = require('../../src/models/User');
const CustomerRepository = require('../../src/models/Customer');
const JobRepository = require('../../src/models/Job');
const EstimateRepository = require('../../src/models/Estimate');
const TimeEntryRepository = require('../../src/models/TimeEntry');
const controller = require('../../src/controllers/timeTrackingController');

describe('timeTrackingController', () => {
  let tenant;
  let customer;
  let job;
  let employee;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme', slug: 'acme' });
    customer = CustomerRepository.create({ tenantId: tenant.id, name: 'Jane' });
    job = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'Job' });
    employee = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g1', email: 'crew@acme.com' });
    UserRepository.update(tenant.id, employee.id, { defaultHourlyCost: 22, defaultBillingRate: 65 });
  });

  describe('clockIn', () => {
    test('snapshots the employee\'s default rates automatically', () => {
      const entry = controller.clockIn(tenant.id, job.id, employee.id, { notes: 'starting' });
      expect(entry.hourlyCost).toBe(22);
      expect(entry.billingRate).toBe(65);
    });

    test('throws 404 for an unknown job', () => {
      expect.assertions(1);
      try {
        controller.clockIn(tenant.id, 'ghost-job', employee.id, {});
      } catch (err) {
        expect(err.status).toBe(404);
      }
    });

    test('works even when the employee has no default rates set (falls back to null)', () => {
      const noRateEmployee = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g2', email: 'other@acme.com' });
      const entry = controller.clockIn(tenant.id, job.id, noRateEmployee.id, {});
      expect(entry.hourlyCost).toBeNull();
      expect(entry.billingRate).toBeNull();
    });

    test('throws 409 once the job is finalized', () => {
      JobRepository.finalizePricing(tenant.id, job.id, {});
      expect.assertions(1);
      try {
        controller.clockIn(tenant.id, job.id, employee.id, {});
      } catch (err) {
        expect(err.status).toBe(409);
      }
    });
  });

  describe('createManualEntry', () => {
    test('uses the employee\'s default rates when no override is given', () => {
      const entry = controller.createManualEntry(tenant.id, job.id, {
        userId: employee.id,
        clockIn: '2026-01-01T08:00:00Z',
        clockOut: '2026-01-01T12:00:00Z',
        createdBy: 'manager-1'
      });
      expect(entry.hourlyCost).toBe(22);
      expect(entry.billingRate).toBe(65);
    });

    test('an explicit rate override wins over the default', () => {
      const entry = controller.createManualEntry(tenant.id, job.id, {
        userId: employee.id,
        clockIn: '2026-01-01T08:00:00Z',
        clockOut: '2026-01-01T12:00:00Z',
        hourlyCost: 33,
        billingRate: 99,
        createdBy: 'manager-1'
      });
      expect(entry.hourlyCost).toBe(33);
      expect(entry.billingRate).toBe(99);
    });

    test('throws 404 for an unknown job', () => {
      expect.assertions(1);
      try {
        controller.createManualEntry(tenant.id, 'ghost-job', { userId: employee.id, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });
      } catch (err) {
        expect(err.status).toBe(404);
      }
    });

    test('throws 404 for an unknown employee', () => {
      expect.assertions(1);
      try {
        controller.createManualEntry(tenant.id, job.id, { userId: 'ghost-user', clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });
      } catch (err) {
        expect(err.status).toBe(404);
      }
    });

    test('throws 409 once the job is finalized', () => {
      JobRepository.finalizePricing(tenant.id, job.id, {});
      expect.assertions(1);
      try {
        controller.createManualEntry(tenant.id, job.id, { userId: employee.id, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });
      } catch (err) {
        expect(err.status).toBe(409);
      }
    });
  });

  describe('getJobPricingSummary', () => {
    test('pulls the job\'s current estimate automatically', () => {
      const estimate = EstimateRepository.create({
        tenantId: tenant.id,
        jobId: job.id,
        lineItems: [{ description: 'Labor', category: 'labor', unit: 'hour', quantity: 4, unitCost: 25, markupType: 'percent', markupValue: 50 }]
      });
      JobRepository.setCurrentEstimate(tenant.id, job.id, estimate.id);

      const summary = controller.getJobPricingSummary(tenant.id, job.id);
      expect(summary.quoted.laborHours).toBe(4);
    });

    test('handles a job with no current estimate', () => {
      const summary = controller.getJobPricingSummary(tenant.id, job.id);
      expect(summary.quoted).toBeNull();
    });

    test('throws 404 for an unknown job', () => {
      expect.assertions(1);
      try {
        controller.getJobPricingSummary(tenant.id, 'ghost-job');
      } catch (err) {
        expect(err.status).toBe(404);
      }
    });
  });

  describe('finalizeJobPricing', () => {
    test('locks every entry and stamps the job as finalized', () => {
      controller.createManualEntry(tenant.id, job.id, { userId: employee.id, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });

      const { job: finalizedJob, summary } = controller.finalizeJobPricing(tenant.id, job.id);

      expect(finalizedJob.finalizedAt).toBeDefined();
      expect(finalizedJob.finalPriceSnapshot).toEqual(summary);
      expect(TimeEntryRepository.listByJob(tenant.id, job.id)[0].locked).toBe(true);
    });

    test('refuses to finalize while someone is still clocked in', () => {
      controller.clockIn(tenant.id, job.id, employee.id, {});
      expect.assertions(1);
      try {
        controller.finalizeJobPricing(tenant.id, job.id);
      } catch (err) {
        expect(err.status).toBe(409);
      }
    });

    test('refuses to finalize twice', () => {
      controller.finalizeJobPricing(tenant.id, job.id);
      expect.assertions(1);
      try {
        controller.finalizeJobPricing(tenant.id, job.id);
      } catch (err) {
        expect(err.status).toBe(409);
      }
    });

    test('throws 404 for an unknown job', () => {
      expect.assertions(1);
      try {
        controller.finalizeJobPricing(tenant.id, 'ghost-job');
      } catch (err) {
        expect(err.status).toBe(404);
      }
    });

    test('a time_and_materials job with an overrun produces a higher final price than the original quote', () => {
      const tmJob = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'T&M Job', pricingModel: 'time_and_materials' });
      const estimate = EstimateRepository.create({
        tenantId: tenant.id,
        jobId: tmJob.id,
        lineItems: [{ description: 'Labor', category: 'labor', unit: 'hour', quantity: 2, unitCost: 25, markupType: 'percent', markupValue: 50 }]
      });
      JobRepository.setCurrentEstimate(tenant.id, tmJob.id, estimate.id);
      controller.createManualEntry(tenant.id, tmJob.id, { userId: employee.id, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T14:00:00Z' }); // 6h actual vs 2h quoted

      const { summary } = controller.finalizeJobPricing(tenant.id, tmJob.id);

      expect(summary.finalPrice).toBeGreaterThan(summary.quoted.totalPrice);
    });
  });
});
