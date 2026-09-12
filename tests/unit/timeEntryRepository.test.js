const { reset } = require('../../src/models/db');
const TimeEntryRepository = require('../../src/models/TimeEntry');

describe('TimeEntryRepository', () => {
  const tenantId = 'tenant-1';
  const jobId = 'job-1';
  const userId = 'user-1';

  beforeEach(() => {
    reset();
  });

  describe('clockIn / clockOut', () => {
    test('clockIn creates an active, self-clocked entry', () => {
      const entry = TimeEntryRepository.clockIn({ tenantId, jobId, userId, hourlyCost: 22, billingRate: 65, notes: 'starting' });

      expect(entry.status).toBe('active');
      expect(entry.entryMethod).toBe('self_clock');
      expect(entry.clockOut).toBeNull();
      expect(entry.durationMinutes).toBeNull();
      expect(entry.hourlyCost).toBe(22);
      expect(entry.billingRate).toBe(65);
      expect(entry.locked).toBe(false);
    });

    test('rejects clockIn without tenantId, jobId, or userId', () => {
      expect(() => TimeEntryRepository.clockIn({ jobId, userId })).toThrow(/required/);
      expect(() => TimeEntryRepository.clockIn({ tenantId, userId })).toThrow(/required/);
      expect(() => TimeEntryRepository.clockIn({ tenantId, jobId })).toThrow(/required/);
    });

    test('rejects a non-numeric hourlyCost/billingRate', () => {
      expect(() => TimeEntryRepository.clockIn({ tenantId, jobId, userId, hourlyCost: 'lots' })).toThrow(/hourlyCost must be a number/);
      expect(() => TimeEntryRepository.clockIn({ tenantId, jobId, userId, billingRate: 'lots' })).toThrow(/billingRate must be a number/);
    });

    test('blocks a second clock-in while one is already active, on the SAME job', () => {
      TimeEntryRepository.clockIn({ tenantId, jobId, userId });
      expect(() => TimeEntryRepository.clockIn({ tenantId, jobId, userId })).toThrow(/already clocked in/);
    });

    test('blocks a second clock-in on a DIFFERENT job too -- one active entry per user, tenant-wide', () => {
      TimeEntryRepository.clockIn({ tenantId, jobId, userId });
      expect(() => TimeEntryRepository.clockIn({ tenantId, jobId: 'job-2', userId })).toThrow(/already clocked in/);
    });

    test('a different user can clock in independently', () => {
      TimeEntryRepository.clockIn({ tenantId, jobId, userId });
      expect(() => TimeEntryRepository.clockIn({ tenantId, jobId, userId: 'user-2' })).not.toThrow();
    });

    test('clockOut completes the active entry and computes duration', () => {
      const active = TimeEntryRepository.clockIn({ tenantId, jobId, userId });
      // backdate clockIn so duration is deterministic and non-zero
      active.clockIn = new Date(Date.now() - 90 * 60 * 1000).toISOString();

      const completed = TimeEntryRepository.clockOut(tenantId, userId, { notes: 'done' });

      expect(completed.status).toBe('completed');
      expect(completed.clockOut).toBeDefined();
      expect(completed.durationMinutes).toBeGreaterThanOrEqual(89);
      expect(completed.durationMinutes).toBeLessThanOrEqual(91);
      expect(completed.notes).toBe('done');
    });

    test('clockOut throws when nothing is active for that user', () => {
      expect(() => TimeEntryRepository.clockOut(tenantId, userId)).toThrow(/not currently clocked in/);
    });

    test('after clockOut, the user can clock in again', () => {
      TimeEntryRepository.clockIn({ tenantId, jobId, userId });
      TimeEntryRepository.clockOut(tenantId, userId);
      expect(() => TimeEntryRepository.clockIn({ tenantId, jobId, userId })).not.toThrow();
    });
  });

  describe('forceClockOut', () => {
    test('manager can close a specific active entry', () => {
      const entry = TimeEntryRepository.clockIn({ tenantId, jobId, userId });
      const closed = TimeEntryRepository.forceClockOut(tenantId, entry.id, { notes: 'forgot to clock out', closedBy: 'manager-1' });

      expect(closed.status).toBe('completed');
      expect(closed.editedBy).toBe('manager-1');
    });

    test('throws on an entry that is not active', () => {
      const entry = TimeEntryRepository.clockIn({ tenantId, jobId, userId });
      TimeEntryRepository.clockOut(tenantId, userId);
      expect(() => TimeEntryRepository.forceClockOut(tenantId, entry.id, {})).toThrow(/Cannot clock out/);
    });

    test('returns null for an unknown entry or wrong tenant', () => {
      expect(TimeEntryRepository.forceClockOut(tenantId, 'ghost', {})).toBeNull();
    });
  });

  describe('createManual', () => {
    test('creates a completed, manually-entered entry with computed duration', () => {
      const entry = TimeEntryRepository.createManual({
        tenantId,
        jobId,
        userId,
        clockIn: '2026-01-01T08:00:00.000Z',
        clockOut: '2026-01-01T12:30:00.000Z',
        hourlyCost: 25,
        billingRate: 70,
        billable: true,
        notes: 'paper timesheet',
        createdBy: 'manager-1'
      });

      expect(entry.entryMethod).toBe('manual');
      expect(entry.status).toBe('completed');
      expect(entry.durationMinutes).toBe(270);
      expect(entry.createdBy).toBe('manager-1');
    });

    test('rejects missing required fields', () => {
      expect(() => TimeEntryRepository.createManual({ tenantId, jobId, userId })).toThrow(/required/);
    });

    test('rejects clockOut at or before clockIn', () => {
      expect(() =>
        TimeEntryRepository.createManual({ tenantId, jobId, userId, clockIn: '2026-01-01T12:00:00Z', clockOut: '2026-01-01T08:00:00Z' })
      ).toThrow(/clockOut must be after clockIn/);
      expect(() =>
        TimeEntryRepository.createManual({ tenantId, jobId, userId, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T08:00:00Z' })
      ).toThrow(/clockOut must be after clockIn/);
    });

    test('does NOT enforce the one-active-entry rule (manual entries are always already-completed)', () => {
      TimeEntryRepository.clockIn({ tenantId, jobId, userId });
      expect(() =>
        TimeEntryRepository.createManual({ tenantId, jobId, userId, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' })
      ).not.toThrow();
    });

    test('billable defaults to true', () => {
      const entry = TimeEntryRepository.createManual({ tenantId, jobId, userId, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });
      expect(entry.billable).toBe(true);
    });
  });

  describe('update', () => {
    test('edits notes/billable/rates on a completed entry', () => {
      const entry = TimeEntryRepository.createManual({ tenantId, jobId, userId, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });
      const updated = TimeEntryRepository.update(tenantId, entry.id, { notes: 'corrected', billable: false, hourlyCost: 30 }, { editedBy: 'manager-1' });

      expect(updated.notes).toBe('corrected');
      expect(updated.billable).toBe(false);
      expect(updated.hourlyCost).toBe(30);
      expect(updated.editedBy).toBe('manager-1');
    });

    test('recomputes durationMinutes when clockIn/clockOut change', () => {
      const entry = TimeEntryRepository.createManual({ tenantId, jobId, userId, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });
      const updated = TimeEntryRepository.update(tenantId, entry.id, { clockOut: '2026-01-01T13:00:00.000Z' });
      expect(updated.durationMinutes).toBe(300);
    });

    test('rejects an edit that makes clockOut <= clockIn', () => {
      const entry = TimeEntryRepository.createManual({ tenantId, jobId, userId, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });
      expect(() => TimeEntryRepository.update(tenantId, entry.id, { clockOut: '2026-01-01T07:00:00Z' })).toThrow(/clockOut must be after clockIn/);
    });

    test('blocks direct clockIn/clockOut edits on an active entry', () => {
      const entry = TimeEntryRepository.clockIn({ tenantId, jobId, userId });
      expect(() => TimeEntryRepository.update(tenantId, entry.id, { clockOut: new Date().toISOString() })).toThrow(/clock out first/);
    });

    test('blocks any edit once locked', () => {
      const entry = TimeEntryRepository.createManual({ tenantId, jobId, userId, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });
      TimeEntryRepository.lockAllForJob(tenantId, jobId);
      expect(() => TimeEntryRepository.update(tenantId, entry.id, { notes: 'x' })).toThrow(/locked/);
    });

    test('returns null for an unknown entry or wrong tenant', () => {
      expect(TimeEntryRepository.update(tenantId, 'ghost', { notes: 'x' })).toBeNull();
    });
  });

  describe('delete', () => {
    test('deletes an unlocked entry', () => {
      const entry = TimeEntryRepository.createManual({ tenantId, jobId, userId, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });
      expect(TimeEntryRepository.delete(tenantId, entry.id)).toBe(true);
      expect(TimeEntryRepository.findById(tenantId, entry.id)).toBeNull();
    });

    test('refuses to delete a locked entry', () => {
      const entry = TimeEntryRepository.createManual({ tenantId, jobId, userId, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });
      TimeEntryRepository.lockAllForJob(tenantId, jobId);
      expect(() => TimeEntryRepository.delete(tenantId, entry.id)).toThrow(/locked/);
    });
  });

  describe('listByJob / listByUser / findActiveForUser / tenant isolation', () => {
    test('lists scope correctly', () => {
      TimeEntryRepository.createManual({ tenantId, jobId, userId, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });
      TimeEntryRepository.createManual({ tenantId, jobId, userId: 'user-2', clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });
      TimeEntryRepository.createManual({ tenantId, jobId: 'job-2', userId, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });

      expect(TimeEntryRepository.listByJob(tenantId, jobId)).toHaveLength(2);
      expect(TimeEntryRepository.listByUser(tenantId, userId)).toHaveLength(2);
      expect(TimeEntryRepository.listByTenant(tenantId)).toHaveLength(3);
    });

    test('findById and lists are tenant-isolated', () => {
      const entry = TimeEntryRepository.createManual({ tenantId, jobId, userId, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });
      expect(TimeEntryRepository.findById('other-tenant', entry.id)).toBeNull();
      expect(TimeEntryRepository.listByJob('other-tenant', jobId)).toHaveLength(0);
    });
  });

  describe('lockAllForJob / cascade deletes', () => {
    test('lockAllForJob locks every entry for that job only', () => {
      const e1 = TimeEntryRepository.createManual({ tenantId, jobId, userId, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });
      const e2 = TimeEntryRepository.createManual({ tenantId, jobId: 'job-2', userId, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });

      const count = TimeEntryRepository.lockAllForJob(tenantId, jobId);

      expect(count).toBe(1);
      expect(TimeEntryRepository.findById(tenantId, e1.id).locked).toBe(true);
      expect(TimeEntryRepository.findById(tenantId, e2.id).locked).toBe(false);
    });

    test('deleteAllForJob and deleteAllForTenant remove the expected entries', () => {
      TimeEntryRepository.createManual({ tenantId, jobId, userId, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });
      TimeEntryRepository.createManual({ tenantId, jobId: 'job-2', userId, clockIn: '2026-01-01T08:00:00Z', clockOut: '2026-01-01T10:00:00Z' });

      expect(TimeEntryRepository.deleteAllForJob(tenantId, jobId)).toBe(1);
      expect(TimeEntryRepository.listByTenant(tenantId)).toHaveLength(1);

      expect(TimeEntryRepository.deleteAllForTenant(tenantId)).toBe(1);
      expect(TimeEntryRepository.listByTenant(tenantId)).toHaveLength(0);
    });
  });
});
