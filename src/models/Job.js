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
    createdBy
  }) {
    if (!tenantId || !customerId || !title) {
      throw new Error('tenantId, customerId, and title are required to create a job');
    }
    if (photos !== undefined && !Array.isArray(photos)) {
      throw new Error('photos must be an array');
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

    const allowed = [
      'title',
      'description',
      'siteAddress',
      'weatherSensitive',
      'weatherNotes',
      'notes',
      'photos',
      'status'
    ];
    for (const key of allowed) {
      if (updates[key] !== undefined) job[key] = updates[key];
    }

    job.updatedAt = new Date().toISOString();
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
