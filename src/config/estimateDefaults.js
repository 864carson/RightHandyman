/**
 * Default numbers for the estimating feature.
 *
 * These are starting points, not law -- every value here can be overridden
 * per line item or per estimate. They exist so a brand-new tenant gets a
 * defensible estimate on day one instead of a blank markup field, per the
 * "different markup for different cost types" guidance: labor carries the
 * most overhead/risk and gets the highest recovery, materials next, then
 * equipment, subcontract, and travel (usually a flat fee, not a %).
 */

const LINE_ITEM_CATEGORIES = Object.freeze([
  'materials',
  'labor',
  'equipment',
  'subcontract',
  'travel',
  'other'
]);

/** Default markup % applied to a line item's cost, by category. */
const DEFAULT_MARKUP_PERCENT_BY_CATEGORY = Object.freeze({
  materials: 30,
  labor: 50,
  equipment: 20,
  subcontract: 15,
  travel: 0, // travel/mobilization is usually a flat trip fee, not a %
  other: 20
});

const MARKUP_TYPES = Object.freeze(['percent', 'fixed']);
const DEPOSIT_TYPES = Object.freeze(['percent', 'fixed']);

/** How many days a customer has to approve an estimate before it lapses. */
const DEFAULT_VALID_DAYS = 14;

/**
 * Boilerplate scope language. Shown on every estimate unless the tenant
 * overrides it -- this is the single sentence that prevents most
 * "I thought that was included" disputes.
 */
const DEFAULT_CHANGE_ORDER_NOTICE =
  'This estimate covers only the work described above. Any additional work, ' +
  'materials, or site conditions discovered once the job is underway are ' +
  'outside this scope and will require a written change order, including any ' +
  'change in price, before that work begins.';

const DEFAULT_PAYMENT_TERMS = '50% deposit due to schedule, balance due on completion.';

module.exports = {
  LINE_ITEM_CATEGORIES,
  DEFAULT_MARKUP_PERCENT_BY_CATEGORY,
  MARKUP_TYPES,
  DEPOSIT_TYPES,
  DEFAULT_VALID_DAYS,
  DEFAULT_CHANGE_ORDER_NOTICE,
  DEFAULT_PAYMENT_TERMS
};
