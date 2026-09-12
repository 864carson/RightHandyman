const { summarizeTimeEntries, buildJobPricingSummary } = require('../../src/services/timeTrackingCalculations');

describe('summarizeTimeEntries', () => {
  test('only counts completed entries toward totals; active entries only bump activeCount', () => {
    const entries = [
      { status: 'completed', durationMinutes: 240, hourlyCost: 22, billingRate: 65, billable: true },
      { status: 'active', durationMinutes: null, hourlyCost: 22, billingRate: 65, billable: true }
    ];
    const summary = summarizeTimeEntries(entries);
    expect(summary.entryCount).toBe(1);
    expect(summary.activeCount).toBe(1);
    expect(summary.totalHours).toBe(4);
  });

  test('cost counts non-billable time too; price/billable figures only count billable=true', () => {
    const entries = [
      { status: 'completed', durationMinutes: 240, hourlyCost: 22, billingRate: 65, billable: true }, // 4h
      { status: 'completed', durationMinutes: 120, hourlyCost: 22, billingRate: 65, billable: false } // 2h non-billable
    ];
    const summary = summarizeTimeEntries(entries);
    expect(summary.totalHours).toBe(6);
    expect(summary.totalCost).toBe(132); // (4+2)*22 -- cost is incurred either way
    expect(summary.billableHours).toBe(4);
    expect(summary.billablePrice).toBe(260); // 4*65 -- only billable hours count toward price
  });

  test('treats a null hourlyCost/billingRate as zero rather than throwing or producing NaN', () => {
    const summary = summarizeTimeEntries([{ status: 'completed', durationMinutes: 60, hourlyCost: null, billingRate: null, billable: true }]);
    expect(summary.totalCost).toBe(0);
    expect(summary.billablePrice).toBe(0);
    expect(summary.totalHours).toBe(1);
  });

  test('an empty list totals to zero without throwing', () => {
    const summary = summarizeTimeEntries([]);
    expect(summary.totalHours).toBe(0);
    expect(summary.totalCost).toBe(0);
    expect(summary.entryCount).toBe(0);
    expect(summary.activeCount).toBe(0);
  });

  test('defaults entries to an empty array when omitted entirely', () => {
    expect(() => summarizeTimeEntries()).not.toThrow();
  });
});

describe('buildJobPricingSummary', () => {
  const estimate = {
    taxRate: 0,
    lineItems: [
      { category: 'labor', unit: 'hour', quantity: 4, unitCost: 25, markupType: 'percent', markupValue: 50 }, // cost 100, price 150
      { category: 'materials', unit: 'yard', quantity: 3, unitCost: 28, markupType: 'percent', markupValue: 30 } // cost 84, price 109.2
    ]
  };

  const actualEntries = [
    { status: 'completed', durationMinutes: 360, hourlyCost: 22, billingRate: 65, billable: true } // 6h actual vs 4h quoted
  ];

  test('fixed-price job: finalPrice equals the quoted total, unaffected by actual hours', () => {
    const summary = buildJobPricingSummary({ job: { pricingModel: 'fixed' }, estimate, timeEntries: actualEntries });

    expect(summary.quoted.laborHours).toBe(4);
    expect(summary.quoted.laborHoursIsPartial).toBe(false);
    expect(summary.actual.totalHours).toBe(6);
    expect(summary.variance.laborHours).toBe(2); // 6 actual - 4 quoted
    expect(summary.variance.laborCost).toBe(32); // (6*22=132) - 100
    expect(summary.finalPrice).toBe(summary.quoted.totalPrice);
  });

  test('time_and_materials job: labor is trued up to actual billable price; non-labor stays quoted', () => {
    const summary = buildJobPricingSummary({ job: { pricingModel: 'time_and_materials' }, estimate, timeEntries: actualEntries });

    const expectedFinal = Math.round((109.2 + 6 * 65) * 100) / 100; // quoted materials + actual billable labor price
    expect(summary.finalPrice).toBe(expectedFinal);
  });

  test('fixed and time_and_materials produce genuinely different final prices from the same underlying data', () => {
    const fixed = buildJobPricingSummary({ job: { pricingModel: 'fixed' }, estimate, timeEntries: actualEntries });
    const tm = buildJobPricingSummary({ job: { pricingModel: 'time_and_materials' }, estimate, timeEntries: actualEntries });
    expect(fixed.finalPrice).not.toBe(tm.finalPrice);
  });

  test('non-billable actual time still counts toward variance/cost but not toward a T&M final price', () => {
    const withNonBillable = [
      { status: 'completed', durationMinutes: 240, hourlyCost: 22, billingRate: 65, billable: true }, // 4h billable
      { status: 'completed', durationMinutes: 120, hourlyCost: 22, billingRate: 65, billable: false } // 2h non-billable (e.g. rework)
    ];
    const summary = buildJobPricingSummary({ job: { pricingModel: 'time_and_materials' }, estimate, timeEntries: withNonBillable });
    const expectedFinal = Math.round((109.2 + 4 * 65) * 100) / 100; // only the 4 billable hours feed the bill
    expect(summary.finalPrice).toBe(expectedFinal);
    expect(summary.actual.totalHours).toBe(6); // but cost/variance still reflects all 6 hours worked
  });

  test('flags laborHoursIsPartial when a labor line is quoted in a non-hour unit', () => {
    const visitEstimate = { taxRate: 0, lineItems: [{ category: 'labor', unit: 'visit', quantity: 1, unitCost: 100, markupType: 'percent', markupValue: 50 }] };
    const summary = buildJobPricingSummary({ job: { pricingModel: 'fixed' }, estimate: visitEstimate, timeEntries: [] });
    expect(summary.quoted.laborHoursIsPartial).toBe(true);
    expect(summary.quoted.laborHours).toBe(0);
    expect(summary.quoted.laborCost).toBeGreaterThan(0); // dollar figures still counted regardless of unit
  });

  test('handles a job with no current estimate gracefully', () => {
    const summary = buildJobPricingSummary({ job: { pricingModel: 'fixed' }, estimate: null, timeEntries: actualEntries });
    expect(summary.quoted).toBeNull();
    expect(summary.variance).toBeNull();
    expect(summary.finalPrice).toBeNull();
    expect(summary.actual.totalHours).toBe(6); // actual data is still computed even with nothing to compare against
  });

  test('a time_and_materials job with no estimate still computes finalPrice from actual billable time alone', () => {
    const summary = buildJobPricingSummary({ job: { pricingModel: 'time_and_materials' }, estimate: null, timeEntries: actualEntries });
    expect(summary.finalPrice).toBe(390); // 6h * 65, no non-labor quoted price to add
  });
});
