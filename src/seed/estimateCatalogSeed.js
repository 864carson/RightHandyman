const CatalogItemRepository = require('../models/CatalogItem');
const EstimateTemplateRepository = require('../models/EstimateTemplate');

/**
 * Small starter catalog (~15 items across 2 trades: landscaping and
 * drainage) plus two packaged templates that use them. Intentionally not
 * exhaustive -- this proves the catalog/template mechanism end-to-end so a
 * tenant can see it working immediately, then add their own regional/
 * specialty items and packages from there. See README for the full list
 * this could grow into per-trade.
 */
const STARTER_CATALOG_ITEMS = [
  // Landscaping - materials
  { trade: 'landscaping', category: 'materials', name: 'Mulch, bulk (per yard)', unit: 'yard', defaultUnitCost: 28 },
  { trade: 'landscaping', category: 'materials', name: 'Topsoil, bulk (per yard)', unit: 'yard', defaultUnitCost: 22 },
  { trade: 'landscaping', category: 'materials', name: 'Landscape fabric', unit: 'roll', defaultUnitCost: 35 },
  { trade: 'landscaping', category: 'materials', name: 'Steel edging', unit: 'linear foot', defaultUnitCost: 3.5 },
  { trade: 'landscaping', category: 'materials', name: 'River rock, decorative', unit: 'yard', defaultUnitCost: 65 },
  // Landscaping - labor / equipment / travel
  { trade: 'landscaping', category: 'labor', name: 'Crew labor, 2-person', unit: 'hour', defaultUnitCost: 45 },
  { trade: 'landscaping', category: 'equipment', name: 'Walk-behind mower', unit: 'hour', defaultUnitCost: 8 },
  { trade: 'landscaping', category: 'equipment', name: 'Dump trailer mobilization', unit: 'day', defaultUnitCost: 40 },
  { trade: 'landscaping', category: 'travel', name: 'Trip / mobilization charge', unit: 'each', defaultUnitCost: 0, defaultMarkupType: 'fixed', defaultMarkupValue: 45 },
  { trade: 'landscaping', category: 'other', name: 'Yard waste haul-away / dump fee', unit: 'load', defaultUnitCost: 60 },

  // Drainage - materials
  { trade: 'drainage', category: 'materials', name: 'Perforated drain pipe, 4in', unit: 'linear foot', defaultUnitCost: 1.8 },
  { trade: 'drainage', category: 'materials', name: 'Drainage gravel', unit: 'yard', defaultUnitCost: 38 },
  { trade: 'drainage', category: 'materials', name: 'Filter fabric', unit: 'roll', defaultUnitCost: 40 },
  { trade: 'drainage', category: 'materials', name: 'Pop-up emitter', unit: 'each', defaultUnitCost: 12 },
  // Drainage - labor / equipment / other
  { trade: 'drainage', category: 'labor', name: 'Crew labor, 2-person', unit: 'hour', defaultUnitCost: 45 },
  { trade: 'drainage', category: 'equipment', name: 'Walk-behind trencher', unit: 'day', defaultUnitCost: 150 },
  { trade: 'drainage', category: 'other', name: 'Permit fee (if required)', unit: 'each', defaultUnitCost: 75, defaultMarkupType: 'fixed', defaultMarkupValue: 0 }
];

const STARTER_TEMPLATES = [
  {
    trade: 'landscaping',
    name: 'Weekly mow + edge',
    description: 'Standard recurring mow, edge, and blow for an average residential lot.',
    lineItems: [
      { description: 'Mow, edge, and blow', category: 'labor', unit: 'visit', defaultQuantity: 1, defaultUnitCost: 35, markupType: 'percent', markupValue: 50 },
      { description: 'Trip / mobilization charge', category: 'travel', unit: 'each', defaultQuantity: 1, defaultUnitCost: 0, markupType: 'fixed', markupValue: 10 }
    ]
  },
  {
    trade: 'landscaping',
    name: 'Mulch bed refresh',
    description: 'Refresh existing beds with a couple inches of new mulch, average residential lot.',
    lineItems: [
      { description: 'Mulch, bulk (per yard)', category: 'materials', unit: 'yard', defaultQuantity: 4, defaultUnitCost: 28, markupType: 'percent', markupValue: 30 },
      { description: 'Crew labor, 2-person', category: 'labor', unit: 'hour', defaultQuantity: 4, defaultUnitCost: 45, markupType: 'percent', markupValue: 50 },
      { description: 'Trip / mobilization charge', category: 'travel', unit: 'each', defaultQuantity: 1, defaultUnitCost: 0, markupType: 'fixed', markupValue: 25 }
    ]
  },
  {
    trade: 'drainage',
    name: 'French drain, 50ft',
    description: 'Standard 50ft French drain, average dig conditions, no permit assumed.',
    lineItems: [
      { description: 'Perforated drain pipe, 4in', category: 'materials', unit: 'linear foot', defaultQuantity: 50, defaultUnitCost: 1.8, markupType: 'percent', markupValue: 35 },
      { description: 'Drainage gravel', category: 'materials', unit: 'yard', defaultQuantity: 3, defaultUnitCost: 38, markupType: 'percent', markupValue: 35 },
      { description: 'Filter fabric', category: 'materials', unit: 'roll', defaultQuantity: 1, defaultUnitCost: 40, markupType: 'percent', markupValue: 35 },
      { description: 'Crew labor, 2-person', category: 'labor', unit: 'hour', defaultQuantity: 8, defaultUnitCost: 45, markupType: 'percent', markupValue: 50 },
      { description: 'Trip / mobilization charge', category: 'travel', unit: 'each', defaultQuantity: 1, defaultUnitCost: 0, markupType: 'fixed', markupValue: 45 }
    ]
  }
];

/** Loads the starter catalog items + templates into a tenant. Idempotent-safe to call repeatedly (see routes/catalogItem.js). */
function seedDefaultCatalog(tenantId, createdBy) {
  const catalogItems = STARTER_CATALOG_ITEMS.map((item) =>
    CatalogItemRepository.create({ ...item, tenantId, createdBy })
  );
  const templates = STARTER_TEMPLATES.map((template) =>
    EstimateTemplateRepository.create({ ...template, tenantId, createdBy })
  );
  return { catalogItems, templates };
}

module.exports = { STARTER_CATALOG_ITEMS, STARTER_TEMPLATES, seedDefaultCatalog };
