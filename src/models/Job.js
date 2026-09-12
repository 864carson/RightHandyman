const { randomUUID } = require('crypto');
const { getStore } = require('./db');

/**
 * A Job is the hub that holds a customer's estimate(s), status, and
 * (eventually) invoice together, so pulling up a customer's history doesn't
 * require chasing several separate lookups. A Job is created either
 * directly (fast path -- most jobs for these trades don't need a formal
 * sales pipeline first) or by converting a won Opportunity
 * (Opportunity.convertToJob, see OpportunityRepository / routes/opportunity.js).
 */
const VALID_JOB_STATUSES = [
  'estimating', // default -- estimate(s) being built/revised, none approved yet
  'approved', // customer approved an estimate; not yet scheduled/started
  'scheduled',
  'in_progress',
  'completed',
  'cancelled'
];

/**
 * 'fixed' (default): the approved estimate's price is what the customer
 * pays, full stop -- tracked time is purely informational, for comparing
 * quoted vs. actual labor and seeing true margin.
 * 'time_and_materials': the labor portion of the final bill is trued up
 * from actual tracked hours x each employee's billing rate, instead of the
 * estimate's quoted labor price; materials/equipment/subcontract/travel
 * stay as quoted either way. See services/timeTrackingCalculations.js and
 * POST /jobs/:id/finalize-pricing.
 */
const VALID_PRICING_MODELS = ['fixed', 'time_and_materials'];

class JobRepository {
  create({
    tenantId,
    customerId,
    opportunityId,
    title,
    description,
    siteAddress,
    weatherSensitive,
    weatherNotes,
    notes,
    photos,
    pricingModel,
    createdBy
  }) {
    if (!tenantId || !customerId || !title) {
      throw new Error('tenantId, customerId, and title are required to create a job');
    }
    if (photos !== undefined && !Array.isArray(photos)) {
      throw new Error('photos must be an array');
    }
    if (pricingModel !== undefined && !VALID_PRICING_MODELS.includes(pricingModel)) {
      throw new Error(`pricingModel must be one of: ${VALID_PRICING_MODELS.join(', ')}`);
    }

    const store = getStore();
    const job = {
      id: randomUUID(),
      tenantId,
      customerId,
      opportunityId: opportunityId || null,
      title,
      description: description || null,
      siteAddress: siteAddress || null,
      // Season/weather caveats live on the job (the site), not the estimate,
      // since they're a property of the work/location, not of one quote.
      weatherSensitive: Boolean(weatherSensitive),
      weatherNotes: weatherNotes || null,
      notes: notes || null,
      // Photos are stored as plain {url, caption} references -- this app
      // doesn't handle file upload/storage itself (no S3/Cloudinary wired
      // up), so the URL is expected to come from wherever the client
      // uploaded the image to. See README for notes on adding real storage.
      photos: Array.isArray(photos) ? photos : [],
      status: 'estimating',
      pricingModel: pricingModel || 'fixed',
      // Set by POST /jobs/:id/finalize-pricing -- once present, no new
      // time entries can be logged against this job and existing ones are
      // locked. Null until then.
      finalizedAt: null,
      finalPriceSnapshot: null,
      // Points at whichever Estimate version is currently "the one" for
      // this job -- the latest draft, or the latest approved version if a
      // change order is in flight. Avoids having to infer "current" from
      // status across a whole version chain on every read.
      currentEstimateId: null,
      createdBy: createdBy || null,
      createdAt: new Date().toISOString()
    };

    store.jobs.set(job.id, job);
    return job;
  }

  findById(tenantId, id) {
    const store = getStore();
    const job = store.jobs.get(id);
    if (!job || job.tenantId !== tenantId) return null;
    return job;
  }

  listByTenant(tenantId) {
    const store = getStore();
    return Array.from(store.jobs.values()).filter((j) => j.tenantId === tenantId);
  }

  listByCustomer(tenantId, customerId) {
    return this.listByTenant(tenantId).filter((j) => j.customerId === customerId);
  }

  /** Partial update. Most fields are mutable; currentEstimateId is not (see setCurrentEstimate). */
  update(tenantId, id, updates = {}) {
    const store = getStore();
    const job = store.jobs.get(id);
    if (!job || job.tenantId !== tenantId) return null;

    if (updates.status !== undefined && !VALID_JOB_STATUSES.includes(updates.status)) {
      throw new Error(`status must be one of: ${VALID_JOB_STATUSES.join(', ')}`);
    }
    if (updates.photos !== undefined && !Array.isArray(updates.photos)) {
      throw new Error('photos must be an array');
    }
    if (updates.pricingModel !== undefined) {
      if (!VALID_PRICING_MODELS.includes(updates.pricingModel)) {
        throw new Error(`pricingModel must be one of: ${VALID_PRICING_MODELS.join(', ')}`);
      }
      if (job.finalizedAt) {
        throw Object.assign(new Error('Cannot change pricingModel -- this job\'s pricing has already been finalized'), {
          status: 409
        });
      }
    }

    const allowed = [
      'title',
      'description',
      'siteAddress',
      'weatherSensitive',
      'weatherNotes',
      'notes',
      'photos',
      'status',
      'pricingModel'
    ];
    for (const key of allowed) {
      if (updates[key] !== undefined) job[key] = updates[key];
    }

    job.updatedAt = new Date().toISOString();
    return job;
  }

  /**
   * Locks in the final pricing snapshot computed by
   * estimateController/timeTrackingCalculations (see routes/job.js
   * POST /:id/finalize-pricing) and marks the job finalized -- from this
   * point on, its pricingModel can't change and no new time entries can be
   * logged against it (see TimeEntry.js).
   */
  finalizePricing(tenantId, id, snapshot) {
    const store = getStore();
    const job = store.jobs.get(id);
    if (!job || job.tenantId !== tenantId) return null;

    job.finalizedAt = new Date().toISOString();
    job.finalPriceSnapshot = snapshot;
    job.updatedAt = job.finalizedAt;
    return job;
  }

  /** Points the job at whichever estimate version is currently active. Internal/controller use. */
  setCurrentEstimate(tenantId, id, estimateId) {
    const store = getStore();
    const job = store.jobs.get(id);
    if (!job || job.tenantId !== tenantId) return null;
    job.currentEstimateId = estimateId;
    job.updatedAt = new Date().toISOString();
    return job;
  }

  delete(tenantId, id) {
    const store = getStore();
    const job = store.jobs.get(id);
    if (!job || job.tenantId !== tenantId) return false;
    store.jobs.delete(id);
    return true;
  }

  /** Removes every job in a tenant. Used when a tenant itself is deleted. */
  deleteAllForTenant(tenantId) {
    let count = 0;
    for (const job of this.listByTenant(tenantId)) {
      this.delete(tenantId, job.id);
      count += 1;
    }
    return count;
  }

  /** Removes every job for a customer. Used when that customer is deleted. */
  deleteAllForCustomer(tenantId, customerId) {
    let count = 0;
    for (const job of this.listByCustomer(tenantId, customerId)) {
      this.delete(tenantId, job.id);
      count += 1;
    }
    return count;
  }
}

module.exports = new JobRepository();
module.exports.JobRepository = JobRepository;
module.exports.VALID_JOB_STATUSES = VALID_JOB_STATUSES;
module.exports.VALID_PRICING_MODELS = VALID_PRICING_MODELS;
