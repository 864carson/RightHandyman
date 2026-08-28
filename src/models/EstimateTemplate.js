const { randomUUID } = require('crypto');
const { getStore } = require('./db');
const { LINE_ITEM_CATEGORIES, MARKUP_TYPES } = require('../config/estimateDefaults');

/**
 * An EstimateTemplate is a pre-built package for a job type the business
 * does over and over ("Weekly mow + edge", "French drain, 50ft"). It bundles
 * a set of line items with typical quantities so the estimator only has to
 * adjust numbers, not build an estimate from a blank screen every time.
 *
 * Applying a template to a job (see estimateController.createFromTemplate)
 * COPIES its lineItems onto a new draft Estimate -- editing a template
 * afterward never changes estimates that already used it.
 */
function validateLineItems(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error('lineItems must be a non-empty array');
  }
  for (const li of lineItems) {
    if (!li.description || typeof li.description !== 'string') {
      throw new Error('each template line item requires a description');
    }
    if (!li.unit || typeof li.unit !== 'string') {
      throw new Error('each template line item requires a unit');
    }
    if (li.category !== undefined && !LINE_ITEM_CATEGORIES.includes(li.category)) {
      throw new Error(`line item category must be one of: ${LINE_ITEM_CATEGORIES.join(', ')}`);
    }
    if (li.markupType !== undefined && !MARKUP_TYPES.includes(li.markupType)) {
      throw new Error(`line item markupType must be one of: ${MARKUP_TYPES.join(', ')}`);
    }
  }
}

class EstimateTemplateRepository {
  create({ tenantId, trade, name, description, lineItems, createdBy }) {
    if (!tenantId || !trade || !name) {
      throw new Error('tenantId, trade, and name are required to create an estimate template');
    }
    validateLineItems(lineItems);

    const store = getStore();
    const template = {
      id: randomUUID(),
      tenantId,
      trade,
      name,
      description: description || null,
      lineItems: lineItems.map((li) => ({
        description: li.description,
        category: li.category || 'materials',
        catalogItemId: li.catalogItemId || null,
        unit: li.unit,
        defaultQuantity: typeof li.defaultQuantity === 'number' ? li.defaultQuantity : 1,
        defaultUnitCost: typeof li.defaultUnitCost === 'number' ? li.defaultUnitCost : 0,
        markupType: li.markupType || 'percent',
        markupValue: typeof li.markupValue === 'number' ? li.markupValue : 0
      })),
      active: true,
      createdBy: createdBy || null,
      createdAt: new Date().toISOString()
    };

    store.estimateTemplates.set(template.id, template);
    return template;
  }

  findById(tenantId, id) {
    const store = getStore();
    const template = store.estimateTemplates.get(id);
    if (!template || template.tenantId !== tenantId) return null;
    return template;
  }

  listByTenant(tenantId, { trade, includeInactive = false } = {}) {
    const store = getStore();
    return Array.from(store.estimateTemplates.values()).filter((t) => {
      if (t.tenantId !== tenantId) return false;
      if (!includeInactive && !t.active) return false;
      if (trade && t.trade !== trade) return false;
      return true;
    });
  }

  update(tenantId, id, updates = {}) {
    const store = getStore();
    const template = store.estimateTemplates.get(id);
    if (!template || template.tenantId !== tenantId) return null;

    if (updates.lineItems !== undefined) validateLineItems(updates.lineItems);

    const allowed = ['trade', 'name', 'description', 'lineItems', 'active'];
    for (const key of allowed) {
      if (updates[key] !== undefined) template[key] = updates[key];
    }

    template.updatedAt = new Date().toISOString();
    return template;
  }

  delete(tenantId, id) {
    const store = getStore();
    const template = store.estimateTemplates.get(id);
    if (!template || template.tenantId !== tenantId) return false;
    store.estimateTemplates.delete(id);
    return true;
  }

  deleteAllForTenant(tenantId) {
    let count = 0;
    for (const t of this.listByTenant(tenantId, { includeInactive: true })) {
      this.delete(tenantId, t.id);
      count += 1;
    }
    return count;
  }
}

module.exports = new EstimateTemplateRepository();
module.exports.EstimateTemplateRepository = EstimateTemplateRepository;
