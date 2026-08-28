const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const CustomerRepository = require('../../src/models/Customer');
const OpportunityRepository = require('../../src/models/Opportunity');
const JobRepository = require('../../src/models/Job');
const EstimateRepository = require('../../src/models/Estimate');
const EstimateTemplateRepository = require('../../src/models/EstimateTemplate');
const controller = require('../../src/controllers/estimateController');

describe('estimateController', () => {
  let tenant;
  let customer;
  let job;

  beforeEach(() => {
    reset();
    tenant = TenantRepository.create({ name: 'Acme', slug: 'acme' });
    customer = CustomerRepository.create({ tenantId: tenant.id, name: 'Jane Homeowner' });
    job = JobRepository.create({ tenantId: tenant.id, customerId: customer.id, title: 'Mulch refresh' });
  });

  describe('createEstimate', () => {
    test('creates an estimate and points the job at it', () => {
      const estimate = controller.createEstimate(tenant.id, { jobId: job.id, title: 'Estimate 1' });
      expect(JobRepository.findById(tenant.id, job.id).currentEstimateId).toBe(estimate.id);
    });

    test('throws a 404-flavored error for an unknown job', () => {
      expect.assertions(2);
      try {
        controller.createEstimate(tenant.id, { jobId: 'ghost-job' });
      } catch (err) {
        expect(err.status).toBe(404);
        expect(err.message).toMatch(/Job not found/);
      }
    });
  });

  describe('createEstimateFromTemplate', () => {
    test('copies template line items with default quantities/costs onto a new draft', () => {
      const template = EstimateTemplateRepository.create({
        tenantId: tenant.id,
        trade: 'landscaping',
        name: 'Mulch bed refresh',
        lineItems: [
          { description: 'Mulch', category: 'materials', unit: 'yard', defaultQuantity: 4, defaultUnitCost: 28, markupType: 'percent', markupValue: 30 }
        ]
      });

      const estimate = controller.createEstimateFromTemplate(tenant.id, { jobId: job.id, templateId: template.id });

      expect(estimate.title).toBe('Mulch bed refresh');
      expect(estimate.lineItems).toHaveLength(1);
      expect(estimate.lineItems[0].quantity).toBe(4);
      expect(estimate.lineItems[0].unitCost).toBe(28);
      expect(JobRepository.findById(tenant.id, job.id).currentEstimateId).toBe(estimate.id);
    });

    test('throws 404 for an unknown template', () => {
      expect.assertions(1);
      try {
        controller.createEstimateFromTemplate(tenant.id, { jobId: job.id, templateId: 'ghost' });
      } catch (err) {
        expect(err.status).toBe(404);
      }
    });
  });

  describe('reviseEstimate', () => {
    test('keeps the job pointer in sync with the newest version', () => {
      const v1 = controller.createEstimate(tenant.id, { jobId: job.id });
      const v2 = controller.reviseEstimate(tenant.id, v1.id, { title: 'Revised' });

      expect(JobRepository.findById(tenant.id, job.id).currentEstimateId).toBe(v2.id);
      expect(v2.version).toBe(2);
    });
  });

  describe('recordApproval', () => {
    test('advances a job from "estimating" to "approved" on first approval', () => {
      const estimate = controller.createEstimate(tenant.id, { jobId: job.id });
      controller.recordApproval(tenant.id, estimate.id, { approvedByName: 'Jane' });

      expect(JobRepository.findById(tenant.id, job.id).status).toBe('approved');
    });

    test('does not override a job status that has already moved further along', () => {
      const estimate = controller.createEstimate(tenant.id, { jobId: job.id });
      JobRepository.update(tenant.id, job.id, { status: 'scheduled' });

      controller.recordApproval(tenant.id, estimate.id, {});

      expect(JobRepository.findById(tenant.id, job.id).status).toBe('scheduled');
    });
  });

  describe('convertOpportunityToJob', () => {
    test('creates a job linked to the opportunity and marks it won', () => {
      const opp = OpportunityRepository.create({ tenantId: tenant.id, customerId: customer.id, name: 'Drainage bid', stage: 'proposal' });

      const job2 = controller.convertOpportunityToJob(tenant.id, opp.id, { siteAddress: '123 Elm St' }, 'user-1');

      expect(job2.customerId).toBe(customer.id);
      expect(job2.opportunityId).toBe(opp.id);
      expect(job2.siteAddress).toBe('123 Elm St');
      expect(OpportunityRepository.findById(tenant.id, opp.id).stage).toBe('won');
    });

    test('throws 404 for an unknown opportunity', () => {
      expect.assertions(1);
      try {
        controller.convertOpportunityToJob(tenant.id, 'ghost-opp', {}, 'user-1');
      } catch (err) {
        expect(err.status).toBe(404);
      }
    });
  });

  describe('view builders', () => {
    let estimate;

    beforeEach(() => {
      estimate = EstimateRepository.create({
        tenantId: tenant.id,
        jobId: job.id,
        taxRate: 5,
        depositType: 'percent',
        depositValue: 50,
        lineItems: [
          { description: 'Mulch', category: 'materials', unit: 'yard', quantity: 4, unitCost: 28, markupType: 'percent', markupValue: 30, notes: 'client-supplied' }
        ],
        notes: 'internal scratch note -- never show this to a customer'
      });
    });

    test('buildInternalView exposes cost, markup, and margin', () => {
      const view = controller.buildInternalView(estimate);
      expect(view.lineItems[0].cost).toBeDefined();
      expect(view.lineItems[0].markupAmount).toBeDefined();
      expect(view.totals.totalCost).toBeGreaterThan(0);
      expect(view.totals.marginPercent).toBeGreaterThan(0);
    });

    test('buildCustomerView never leaks cost, markup, or the internal notes field', () => {
      const view = controller.buildCustomerView(estimate);
      const serialized = JSON.stringify(view);

      expect(view.lineItems[0].cost).toBeUndefined();
      expect(view.lineItems[0].markupAmount).toBeUndefined();
      expect(view.lineItems[0].unitCost).toBeUndefined();
      expect(serialized).not.toMatch(/markupValue/);
      expect(serialized).not.toMatch(/marginPercent/);
      expect(serialized).not.toMatch(/internal scratch note/);
    });

    test('buildCustomerView keeps per-line notes (scope clarifications like "client-supplied")', () => {
      const view = controller.buildCustomerView(estimate);
      expect(view.lineItems[0].notes).toBe('client-supplied');
    });

    test('both views agree on the bottom-line total price', () => {
      const internal = controller.buildInternalView(estimate);
      const customerView = controller.buildCustomerView(estimate);
      expect(customerView.totalPrice).toBe(internal.totals.totalPrice);
      expect(customerView.deposit).toBe(internal.totals.deposit);
    });
  });
});
