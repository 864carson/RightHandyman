/**
 * Redaction applied ONLY during an impersonation session (see
 * middleware/requirePermission.js / requireRole.js for how a session gets
 * marked, and routes/customer.js + routes/estimate.js for where these are
 * called). A tenant's own real members never have anything redacted --
 * this exists purely to put a default guardrail on cross-tenant platform
 * support access, not to change what a genuine owner/admin/member sees.
 *
 * Both functions are pure: given an object, return a new (shallow-copied)
 * object with sensitive fields nulled out and a `*Redacted: true` marker
 * so a frontend can render a "reveal" affordance instead of just silently
 * showing blanks. Pass `{ reveal: true }` to get the data back untouched
 * (callers are responsible for audit-logging every reveal -- see
 * routes/customer.js and routes/estimate.js).
 */

function redactCustomerPII(customer, { reveal = false } = {}) {
  if (reveal) return { ...customer, piiRedacted: false };

  return {
    ...customer,
    email: customer.email ? '[hidden -- pass ?reveal=true]' : customer.email,
    phone: customer.phone ? '[hidden -- pass ?reveal=true]' : customer.phone,
    piiRedacted: true
  };
}

/**
 * Strips cost/markup/margin from an internal estimate view (the shape
 * produced by estimateController.buildInternalView). Price, tax, deposit,
 * and balance due are left intact -- those are needed to actually operate
 * the estimate (approve/send it) without exposing the tenant's competitive
 * cost/margin numbers.
 */
function redactEstimateFinancials(internalView, { reveal = false } = {}) {
  if (reveal) return { ...internalView, financialsRedacted: false };

  const lineItems = internalView.lineItems.map((li) => {
    const { cost, markupAmount, markupValue, unitCost, marginPercent, ...safe } = li;
    return safe;
  });

  const byCategory = {};
  for (const [category, values] of Object.entries(internalView.totals.byCategory)) {
    byCategory[category] = { price: values.price };
  }

  return {
    ...internalView,
    lineItems,
    totals: {
      taxRate: internalView.totals.taxRate,
      taxAmount: internalView.totals.taxAmount,
      totalPrice: internalView.totals.totalPrice,
      depositType: internalView.totals.depositType,
      depositValue: internalView.totals.depositValue,
      deposit: internalView.totals.deposit,
      balanceDue: internalView.totals.balanceDue,
      byCategory
    },
    financialsRedacted: true
  };
}

/**
 * Strips hourlyCost (payroll cost) from a single TimeEntry -- duration,
 * notes, status, and billingRate (customer-facing price side, same "keep
 * price, hide cost" split as redactEstimateFinancials) stay visible.
 */
function redactTimeEntryFinancials(entry, { reveal = false } = {}) {
  if (reveal) return { ...entry, financialsRedacted: false };

  const { hourlyCost, ...safe } = entry;
  return { ...safe, financialsRedacted: true };
}

/**
 * Strips the cost-side figures from a job pricing summary (see
 * services/timeTrackingCalculations.js buildJobPricingSummary) --
 * quoted/actual labor COST and the cost variance. Hours, billable price,
 * and finalPrice (all price-side, what the business would actually
 * charge/quote) stay visible.
 */
function redactTimeSummaryFinancials(summary, { reveal = false } = {}) {
  if (reveal) return { ...summary, financialsRedacted: false };

  const { totalCost, ...safeActual } = summary.actual;
  const safeQuoted = summary.quoted ? (({ laborCost, ...rest }) => rest)(summary.quoted) : null;
  const safeVariance = summary.variance ? (({ laborCost, ...rest }) => rest)(summary.variance) : null;

  return {
    ...summary,
    quoted: safeQuoted,
    actual: safeActual,
    variance: safeVariance,
    financialsRedacted: true
  };
}

module.exports = { redactCustomerPII, redactEstimateFinancials, redactTimeEntryFinancials, redactTimeSummaryFinancials };
