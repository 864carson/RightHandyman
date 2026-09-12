const JobRepository = require('../models/Job');
const UserRepository = require('../models/User');
const EstimateRepository = require('../models/Estimate');
const TimeEntryRepository = require('../models/TimeEntry');
const { buildJobPricingSummary } = require('../services/timeTrackingCalculations');

function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}

function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

/** Explicit overrides win; otherwise falls back to the employee's stored default rates (either may be null). */
function resolveRates(user, { hourlyCost, billingRate } = {}) {
  return {
    hourlyCost: hourlyCost !== undefined ? hourlyCost : user ? user.defaultHourlyCost : null,
    billingRate: billingRate !== undefined ? billingRate : user ? user.defaultBillingRate : null
  };
}

function assertJobNotFinalized(job) {
  if (job.finalizedAt) {
    throw conflict('This job\'s pricing has already been finalized -- no new time entries can be logged against it');
  }
}

/** Self clock-in: snapshots the caller's own default rates onto the new entry. */
function clockIn(tenantId, jobId, userId, { notes } = {}) {
  const job = JobRepository.findById(tenantId, jobId);
  if (!job) throw notFound('Job not found');
  assertJobNotFinalized(job);

  const user = UserRepository.findById(tenantId, userId);
  const { hourlyCost, billingRate } = resolveRates(user);
  return TimeEntryRepository.clockIn({ tenantId, jobId, userId, hourlyCost, billingRate, notes });
}

/** Manager-entered time on behalf of a specific employee -- rate overrides win, otherwise their stored defaults. */
function createManualEntry(tenantId, jobId, { userId, clockIn: clockInTime, clockOut: clockOutTime, notes, billable, hourlyCost, billingRate, createdBy }) {
  const job = JobRepository.findById(tenantId, jobId);
  if (!job) throw notFound('Job not found');
  assertJobNotFinalized(job);

  const targetUser = UserRepository.findById(tenantId, userId);
  if (!targetUser) throw notFound('Employee (user) not found in this tenant');

  const rates = resolveRates(targetUser, { hourlyCost, billingRate });
  return TimeEntryRepository.createManual({
    tenantId,
    jobId,
    userId,
    clockIn: clockInTime,
    clockOut: clockOutTime,
    hourlyCost: rates.hourlyCost,
    billingRate: rates.billingRate,
    billable,
    notes,
    createdBy
  });
}

/** Quoted-vs-actual (fixed jobs) or trued-up final price (time_and_materials jobs), computed fresh every time. */
function getJobPricingSummary(tenantId, jobId) {
  const job = JobRepository.findById(tenantId, jobId);
  if (!job) throw notFound('Job not found');

  const estimate = job.currentEstimateId ? EstimateRepository.findById(tenantId, job.currentEstimateId) : null;
  const timeEntries = TimeEntryRepository.listByJob(tenantId, jobId);
  return buildJobPricingSummary({ job, estimate, timeEntries });
}

/**
 * Locks in the final numbers: refuses if anyone's still clocked in on this
 * job (no silently guessing an end time), otherwise computes the summary,
 * locks every time entry for the job so they can no longer be edited, and
 * stamps the job as finalized with that snapshot.
 */
function finalizeJobPricing(tenantId, jobId) {
  const job = JobRepository.findById(tenantId, jobId);
  if (!job) throw notFound('Job not found');
  if (job.finalizedAt) throw conflict('This job\'s pricing has already been finalized');

  const entries = TimeEntryRepository.listByJob(tenantId, jobId);
  if (entries.some((e) => e.status === 'active')) {
    throw conflict('Someone is still clocked in on this job -- clock them out before finalizing pricing');
  }

  const summary = getJobPricingSummary(tenantId, jobId);
  TimeEntryRepository.lockAllForJob(tenantId, jobId);
  const finalizedJob = JobRepository.finalizePricing(tenantId, jobId, summary);
  return { job: finalizedJob, summary };
}

module.exports = { clockIn, createManualEntry, getJobPricingSummary, finalizeJobPricing };
