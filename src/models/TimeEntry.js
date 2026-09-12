const { randomUUID } = require('crypto');
const { getStore } = require('./db');

/**
 * A TimeEntry is one block of an employee's time logged against a Job --
 * either self clock-in/out in the field, or a manager entering hours after
 * the fact (a paper timesheet, a forgotten clock-out, etc). This is the
 * feature that lets "quoted vs. actual" become a real number instead of a
 * guess, and what a time-and-materials job's final bill is trued up from
 * (see services/timeTrackingCalculations.js and
 * controllers/timeTrackingController.js for the orchestration/math -- this
 * repository only knows about TimeEntry records themselves).
 *
 * `hourlyCost`/`billingRate` are snapshotted onto the entry at creation
 * time from the employee's User.defaultHourlyCost/defaultBillingRate (with
 * per-entry override support, e.g. an overtime rate) -- a later change to
 * someone's default rate never silently rewrites historical entries.
 */
const STATUSES = ['active', 'completed'];
const ENTRY_METHODS = ['self_clock', 'manual'];

function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function validateRate(value, fieldName) {
  if (value !== undefined && value !== null && typeof value !== 'number') {
    throw badRequest(`${fieldName} must be a number or null`);
  }
}

function minutesBetween(startIso, endIso) {
  return Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000);
}

class TimeEntryRepository {
  /**
   * Self clock-in. Enforces at most one active entry per user across the
   * whole tenant (not just per job) -- a person can't physically be
   * clocked into two jobs at once.
   */
  clockIn({ tenantId, jobId, userId, hourlyCost, billingRate, notes }) {
    if (!tenantId || !jobId || !userId) {
      throw new Error('tenantId, jobId, and userId are required to clock in');
    }
    validateRate(hourlyCost, 'hourlyCost');
    validateRate(billingRate, 'billingRate');

    if (this.findActiveForUser(tenantId, userId)) {
      throw conflict('This user is already clocked in on another entry -- clock out first');
    }

    const store = getStore();
    const now = new Date().toISOString();
    const entry = {
      id: randomUUID(),
      tenantId,
      jobId,
      userId,
      status: 'active',
      entryMethod: 'self_clock',
      clockIn: now,
      clockOut: null,
      durationMinutes: null,
      hourlyCost: typeof hourlyCost === 'number' ? hourlyCost : null,
      billingRate: typeof billingRate === 'number' ? billingRate : null,
      billable: true,
      notes: notes || null,
      locked: false,
      createdBy: userId,
      editedBy: null,
      createdAt: now
    };

    store.timeEntries.set(entry.id, entry);
    return entry;
  }

  /** Closes out whichever entry is currently active for this user, wherever it is. */
  clockOut(tenantId, userId, { notes } = {}) {
    const active = this.findActiveForUser(tenantId, userId);
    if (!active) {
      throw conflict('This user is not currently clocked in');
    }
    return this._complete(active, { notes });
  }

  /** Manager-initiated close of a SPECIFIC entry (e.g. an employee forgot to clock out). */
  forceClockOut(tenantId, id, { notes, closedBy } = {}) {
    const store = getStore();
    const entry = store.timeEntries.get(id);
    if (!entry || entry.tenantId !== tenantId) return null;
    if (entry.status !== 'active') {
      throw conflict(`Cannot clock out an entry with status "${entry.status}"`);
    }
    return this._complete(entry, { notes, editedBy: closedBy });
  }

  _complete(entry, { notes, editedBy } = {}) {
    const now = new Date().toISOString();
    entry.clockOut = now;
    entry.durationMinutes = minutesBetween(entry.clockIn, now);
    entry.status = 'completed';
    if (notes !== undefined) entry.notes = notes;
    if (editedBy) entry.editedBy = editedBy;
    entry.updatedAt = now;
    return entry;
  }

  /**
   * A complete entry created directly (paper timesheet, correcting a
   * forgotten clock-out, logging on behalf of someone else) rather than
   * through live clock-in/out.
   */
  createManual({ tenantId, jobId, userId, clockIn, clockOut, hourlyCost, billingRate, billable, notes, createdBy }) {
    if (!tenantId || !jobId || !userId || !clockIn || !clockOut) {
      throw new Error('tenantId, jobId, userId, clockIn, and clockOut are required for a manual time entry');
    }
    validateRate(hourlyCost, 'hourlyCost');
    validateRate(billingRate, 'billingRate');
    if (new Date(clockOut).getTime() <= new Date(clockIn).getTime()) {
      throw badRequest('clockOut must be after clockIn');
    }

    const store = getStore();
    const now = new Date().toISOString();
    const entry = {
      id: randomUUID(),
      tenantId,
      jobId,
      userId,
      status: 'completed',
      entryMethod: 'manual',
      clockIn: new Date(clockIn).toISOString(),
      clockOut: new Date(clockOut).toISOString(),
      durationMinutes: minutesBetween(clockIn, clockOut),
      hourlyCost: typeof hourlyCost === 'number' ? hourlyCost : null,
      billingRate: typeof billingRate === 'number' ? billingRate : null,
      billable: billable !== undefined ? Boolean(billable) : true,
      notes: notes || null,
      locked: false,
      createdBy: createdBy || null,
      editedBy: null,
      createdAt: now
    };

    store.timeEntries.set(entry.id, entry);
    return entry;
  }

  findById(tenantId, id) {
    const store = getStore();
    const entry = store.timeEntries.get(id);
    if (!entry || entry.tenantId !== tenantId) return null;
    return entry;
  }

  /** The one entry (if any) a user is currently clocked into, tenant-wide. */
  findActiveForUser(tenantId, userId) {
    const store = getStore();
    return (
      Array.from(store.timeEntries.values()).find(
        (e) => e.tenantId === tenantId && e.userId === userId && e.status === 'active'
      ) || null
    );
  }

  listByJob(tenantId, jobId) {
    const store = getStore();
    return Array.from(store.timeEntries.values()).filter((e) => e.tenantId === tenantId && e.jobId === jobId);
  }

  listByUser(tenantId, userId) {
    const store = getStore();
    return Array.from(store.timeEntries.values()).filter((e) => e.tenantId === tenantId && e.userId === userId);
  }

  listByTenant(tenantId) {
    const store = getStore();
    return Array.from(store.timeEntries.values()).filter((e) => e.tenantId === tenantId);
  }

  /**
   * Edits notes/billable/rates/times on a not-yet-locked entry. Editing
   * clockIn/clockOut recomputes durationMinutes; editing an active entry's
   * times is not supported here -- clock it out (or forceClockOut) first.
   */
  update(tenantId, id, updates = {}, { editedBy } = {}) {
    const store = getStore();
    const entry = store.timeEntries.get(id);
    if (!entry || entry.tenantId !== tenantId) return null;
    if (entry.locked) {
      throw conflict('This time entry is locked (its job\'s pricing has been finalized) and can no longer be edited');
    }
    if (updates.hourlyCost !== undefined) validateRate(updates.hourlyCost, 'hourlyCost');
    if (updates.billingRate !== undefined) validateRate(updates.billingRate, 'billingRate');

    const allowed = ['notes', 'billable', 'hourlyCost', 'billingRate'];
    for (const key of allowed) {
      if (updates[key] !== undefined) entry[key] = updates[key];
    }

    if (updates.clockIn !== undefined || updates.clockOut !== undefined) {
      if (entry.status !== 'completed') {
        throw conflict('Cannot directly edit clockIn/clockOut on an active entry -- clock out first');
      }
      const newClockIn = updates.clockIn !== undefined ? new Date(updates.clockIn).toISOString() : entry.clockIn;
      const newClockOut = updates.clockOut !== undefined ? new Date(updates.clockOut).toISOString() : entry.clockOut;
      if (new Date(newClockOut).getTime() <= new Date(newClockIn).getTime()) {
        throw badRequest('clockOut must be after clockIn');
      }
      entry.clockIn = newClockIn;
      entry.clockOut = newClockOut;
      entry.durationMinutes = minutesBetween(newClockIn, newClockOut);
    }

    entry.editedBy = editedBy || entry.editedBy;
    entry.updatedAt = new Date().toISOString();
    return entry;
  }

  delete(tenantId, id) {
    const store = getStore();
    const entry = store.timeEntries.get(id);
    if (!entry || entry.tenantId !== tenantId) return false;
    if (entry.locked) {
      throw conflict('This time entry is locked (its job\'s pricing has been finalized) and can no longer be deleted');
    }
    store.timeEntries.delete(id);
    return true;
  }

  /** Locks every entry for a job so it can no longer be edited/deleted. Used by finalize-pricing. */
  lockAllForJob(tenantId, jobId) {
    let count = 0;
    for (const entry of this.listByJob(tenantId, jobId)) {
      entry.locked = true;
      count += 1;
    }
    return count;
  }

  deleteAllForJob(tenantId, jobId) {
    const store = getStore();
    let count = 0;
    for (const entry of this.listByJob(tenantId, jobId)) {
      store.timeEntries.delete(entry.id);
      count += 1;
    }
    return count;
  }

  deleteAllForTenant(tenantId) {
    const store = getStore();
    let count = 0;
    for (const entry of this.listByTenant(tenantId)) {
      store.timeEntries.delete(entry.id);
      count += 1;
    }
    return count;
  }
}

module.exports = new TimeEntryRepository();
module.exports.TimeEntryRepository = TimeEntryRepository;
module.exports.STATUSES = STATUSES;
module.exports.ENTRY_METHODS = ENTRY_METHODS;
