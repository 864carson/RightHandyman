/**
 * Pure calculation engine for estimates. No side effects, no store access --
 * takes plain data in, returns plain numbers out. This is deliberate:
 *
 *   1. Totals are NEVER stored. An estimate's lineItems (cost, quantity,
 *      markup) are the only source of truth; totals are recomputed fresh on
 *      every read. That makes "stale total after editing a line item" a bug
 *      class that literally cannot happen here.
 *   2. Being pure functions with no dependencies makes this the easiest,
 *      highest-value part of the whole feature to unit test exhaustively --
 *      money math is exactly where you want that.
 *
 * Money handling: all inputs/outputs are plain JS numbers rounded to 2
 * decimal places at each step (not left to float all the way through), to
 * keep compounding floating-point drift out of the customer-facing total.
 * For very high-volume/high-precision billing you'd reach for an
 * integer-cents or decimal library instead -- overkill for this app's scale.
 */

const { MARKUP_TYPES, DEPOSIT_TYPES } = require('../config/estimateDefaults');

/** Rounds to 2 decimal places, guarding against -0 and float noise. */
function round2(value) {
  const rounded = Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

function sum(numbers) {
  return round2(numbers.reduce((total, n) => total + n, 0));
}

/**
 * Computes cost/markup/price for a single line item.
 *
 * - cost = quantity x unitCost (what it costs the business)
 * - markupAmount:
 *     'percent' -> cost x (markupValue / 100)
 *     'fixed'   -> markupValue, applied once for the whole line (not
 *                  per-unit) -- a flat trip fee is a flat trip fee whether
 *                  you quote 1 hour or 4
 * - price = cost + markupAmount (what the customer pays for this line)
 */
function calculateLineItem(item = {}) {
  const quantity = Number(item.quantity) || 0;
  const unitCost = Number(item.unitCost) || 0;
  const markupType = MARKUP_TYPES.includes(item.markupType) ? item.markupType : 'percent';
  const markupValue = Number(item.markupValue) || 0;

  const cost = round2(quantity * unitCost);
  const markupAmount =
    markupType === 'fixed' ? round2(markupValue) : round2(cost * (markupValue / 100));
  const price = round2(cost + markupAmount);
  const marginPercent = price > 0 ? round2((markupAmount / price) * 100) : 0;

  return { cost, markupAmount, price, marginPercent };
}

/** Deposit amount owed up front, given the final total price. */
function calculateDeposit({ depositType, depositValue } = {}, totalPrice) {
  if (!depositType) return 0;
  const value = Number(depositValue) || 0;

  if (depositType === 'percent') return round2(totalPrice * (value / 100));
  if (depositType === 'fixed') return round2(Math.min(value, totalPrice));
  return 0;
}

/**
 * Full estimate totals: every line item resolved, rolled up by category,
 * then cost -> markup -> subtotal -> tax -> total -> deposit -> balance.
 *
 * Returns a new object; never mutates the estimate/lineItems passed in.
 */
function calculateEstimateTotals(estimate = {}) {
  const lineItems = Array.isArray(estimate.lineItems) ? estimate.lineItems : [];

  const resolvedLineItems = lineItems.map((item) => ({
    ...item,
    ...calculateLineItem(item)
  }));

  const totalCost = sum(resolvedLineItems.map((li) => li.cost));
  const totalMarkup = sum(resolvedLineItems.map((li) => li.markupAmount));
  const subtotalPrice = round2(totalCost + totalMarkup);

  const taxRate = Number(estimate.taxRate) || 0;
  const taxAmount = round2(subtotalPrice * (taxRate / 100));
  const totalPrice = round2(subtotalPrice + taxAmount);

  const marginPercent = subtotalPrice > 0 ? round2((totalMarkup / subtotalPrice) * 100) : 0;

  const deposit = calculateDeposit(estimate, totalPrice);
  const balanceDue = round2(totalPrice - deposit);

  const byCategory = {};
  for (const li of resolvedLineItems) {
    const category = li.category || 'other';
    if (!byCategory[category]) {
      byCategory[category] = { cost: 0, markupAmount: 0, price: 0 };
    }
    byCategory[category].cost = round2(byCategory[category].cost + li.cost);
    byCategory[category].markupAmount = round2(byCategory[category].markupAmount + li.markupAmount);
    byCategory[category].price = round2(byCategory[category].price + li.price);
  }

  return {
    lineItems: resolvedLineItems,
    byCategory,
    totalCost,
    totalMarkup,
    subtotalPrice,
    taxRate,
    taxAmount,
    totalPrice,
    marginPercent,
    depositType: DEPOSIT_TYPES.includes(estimate.depositType) ? estimate.depositType : null,
    depositValue: estimate.depositValue != null ? Number(estimate.depositValue) : null,
    deposit,
    balanceDue
  };
}

/**
 * "What if I dropped this markup by X%?" helper for the internal view --
 * shows the owner the profit impact of a discount before they offer one.
 * Applies the delta uniformly across every line's markup, floored at 0.
 */
function projectMarkupChange(estimate, markupPercentDelta) {
  const adjusted = {
    ...estimate,
    lineItems: (estimate.lineItems || []).map((item) => {
      if (item.markupType === 'fixed') return item; // flat fees aren't a %, leave as-is
      const newMarkupValue = Math.max(0, (Number(item.markupValue) || 0) + markupPercentDelta);
      return { ...item, markupValue: newMarkupValue };
    })
  };
  return calculateEstimateTotals(adjusted);
}

module.exports = {
  round2,
  calculateLineItem,
  calculateDeposit,
  calculateEstimateTotals,
  projectMarkupChange
};
