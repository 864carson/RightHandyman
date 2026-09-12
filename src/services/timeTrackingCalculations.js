/**
 * Pure calculation functions for time tracking -- no side effects, no
 * store access, same philosophy as services/estimateCalculations.js. Takes
 * plain TimeEntry/Estimate/Job data in, returns plain summary numbers out,
 * so this is trivial to unit test exhaustively and impossible to leave
 * out of sync with what's actually stored.
 */

const { round2, calculateEstimateTotals } = require('./estimateCalculations');

/**
 * Rolls up a job's (or a user's) time entries into hours/cost/billable
 * totals. Only 'completed' entries count toward totals -- an entry someone
 * is still clocked into contributes to `activeCount` only, never to hours
 * or cost, so a summary never silently changes just because someone
 * hasn't clocked out yet.
 */
function summarizeTimeEntries(entries = []) {
  const completed = entries.filter((e) => e.status === 'completed');
  const active = entries.filter((e) => e.status === 'active');

  let totalMinutes = 0;
  let totalCost = 0;
  let billableMinutes = 0;
  let billablePrice = 0;

  for (const entry of completed) {
    const minutes = entry.durationMinutes || 0;
    const hours = minutes / 60;
    totalMinutes += minutes;
    totalCost += hours * (entry.hourlyCost || 0);

    if (entry.billable) {
      billableMinutes += minutes;
      billablePrice += hours * (entry.billingRate || 0);
    }
  }

  return {
    entryCount: completed.length,
    activeCount: active.length,
    totalMinutes,
    totalHours: round2(totalMinutes / 60),
    totalCost: round2(totalCost),
    billableMinutes,
    billableHours: round2(billableMinutes / 60),
    billablePrice: round2(billablePrice)
  };
}

/**
 * Combines a job's quoted labor (from its current estimate's labor-category
 * line items) with actual tracked time into one comparison, and -- for a
 * time_and_materials job -- the trued-up final price.
 *
 * `quotedLaborHours` only sums labor line items quoted in `unit: 'hour'`;
 * a labor line quoted as "1 visit" or "2 days" has no hour figure to
 * compare against, so it's excluded from the hours comparison (but its
 * cost/price still count in the dollar figures, which are unit-agnostic).
 * `quotedLaborHoursIsPartial` is set when that happened, so a caller can
 * flag the hours comparison as incomplete rather than silently understating
 * quoted hours.
 *
 * Non-labor line items (materials/equipment/subcontract/travel/other)
 * always stay AS QUOTED, in both pricing models -- only the labor portion
 * is ever trued up from actual hours.
 */
function buildJobPricingSummary({ job, estimate, timeEntries = [] }) {
  const actual = summarizeTimeEntries(timeEntries);

  let quoted = null;
  let nonLaborPrice = 0;

  if (estimate) {
    const totals = calculateEstimateTotals(estimate);
    let quotedLaborHours = 0;
    let quotedLaborCost = 0;
    let quotedLaborPrice = 0;
    let quotedLaborHoursIsPartial = false;

    for (const li of totals.lineItems) {
      if (li.category === 'labor') {
        quotedLaborCost += li.cost;
        quotedLaborPrice += li.price;
        if (li.unit === 'hour') {
          quotedLaborHours += li.quantity;
        } else {
          quotedLaborHoursIsPartial = true;
        }
      } else {
        nonLaborPrice += li.price;
      }
    }

    quoted = {
      laborHours: round2(quotedLaborHours),
      laborHoursIsPartial: quotedLaborHoursIsPartial,
      laborCost: round2(quotedLaborCost),
      laborPrice: round2(quotedLaborPrice),
      nonLaborPrice: round2(nonLaborPrice),
      totalPrice: totals.totalPrice
    };
  }

  const variance = quoted
    ? {
        laborHours: round2(actual.totalHours - quoted.laborHours),
        laborCost: round2(actual.totalCost - quoted.laborCost)
      }
    : null;

  let finalPrice = null;
  if (job.pricingModel === 'time_and_materials') {
    // Labor is trued up to actual billable hours; everything else stays quoted.
    finalPrice = round2(round2(nonLaborPrice) + actual.billablePrice);
  } else if (quoted) {
    // Fixed price -- the customer pays what was quoted, regardless of
    // actual hours. Carried through here purely for a single consistent
    // "here's the final number" field regardless of pricing model.
    finalPrice = quoted.totalPrice;
  }

  return {
    pricingModel: job.pricingModel,
    quoted,
    actual,
    variance,
    finalPrice
  };
}

module.exports = { summarizeTimeEntries, buildJobPricingSummary };
