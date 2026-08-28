const { randomUUID } = require('crypto');
const { getStore } = require('./db');
const {
  LINE_ITEM_CATEGORIES,
  MARKUP_TYPES,
  DEFAULT_MARKUP_PERCENT_BY_CATEGORY
} = require('../config/estimateDefaults');

/**
 * A CatalogItem is a reusable, editable price-book entry ("Mulch, bulk
 * yard", "Labor, 2-person crew hour") that an estimator taps to add a line
 * to an estimate quickly instead of typing cost/markup from memory every
 * time. One shared catalog per tenant (not per-user) -- these businesses
 * are small enough that a single, owner-maintained cost list is simpler to
 * keep accurate than reconciling per-user copies.
 *
 * Estimate line items COPY these values at the time they're added, they
 * don't reference the catalog item live. That means editing or removing a
 * catalog entry never changes the numbers on an estimate that already went
 * out the door.
 */
class CatalogItemRepository {
  create({
    tenantId,
    trade,
    category,
    name,
    unit,
    defaultUnitCost,
    defaultMarkupType,
    defaultMarkupValue,
    notes,
    createdBy
  }) {
    if (!tenantId || !trade || !name || !unit) {
      throw new Error('tenantId, trade, name, and unit are required to create a catalog item');
    }
    if (category !== undefined && !LINE_ITEM_CATEGORIES.includes(category)) {
      throw new Error(`category must be one of: ${LINE_ITEM_CATEGORIES.join(', ')}`);
    }
    if (defaultMarkupType !== undefined && !MARKUP_TYPES.includes(defaultMarkupType)) {
      throw new Error(`defaultMarkupType must be one of: ${MARKUP_TYPES.join(', ')}`);
    }

    const resolvedCategory = category || 'materials';
    const store = getStore();
    const item = {
      id: randomUUID(),
      tenantId,
      trade,
      category: resolvedCategory,
      name,
      unit,
      defaultUnitCost: typeof defaultUnitCost === 'number' ? defaultUnitCost : 0,
      defaultMarkupType: defaultMarkupType || 'percent',
      defaultMarkupValue:
        typeof defaultMarkupValue === 'number'
          ? defaultMarkupValue
          : DEFAULT_MARKUP_PERCENT_BY_CATEGORY[resolvedCategory] ?? 0,
      notes: notes || null,
      active: true,
      createdBy: createdBy || null,
      createdAt: new Date().toISOString()
    };

    store.catalogItems.set(item.id, item);
    return item;
  }

  findById(tenantId, id) {
    const store = getStore();
    const item = store.catalogItems.get(id);
    if (!item || item.tenantId !== tenantId) return null;
    return item;
  }

  /** Lists active catalog items for a tenant, optionally filtered by trade and/or category. */
  listByTenant(tenantId, { trade, category, includeInactive = false } = {}) {
    const store = getStore();
    return Array.from(store.catalogItems.values()).filter((item) => {
      if (item.tenantId !== tenantId) return false;
      if (!includeInactive && !item.active) return false;
      if (trade && item.trade !== trade) return false;
      if (category && item.category !== category) return false;
      return true;
    });
  }

  /** Partial update. name, unit, defaultUnitCost, markup fields, notes, trade, category, active are mutable. */
  update(tenantId, id, updates = {}) {
    const store = getStore();
    const item = store.catalogItems.get(id);
    if (!item || item.tenantId !== tenantId) return null;

    if (updates.category !== undefined && !LINE_ITEM_CATEGORIES.includes(updates.category)) {
      throw new Error(`category must be one of: ${LINE_ITEM_CATEGORIES.join(', ')}`);
    }
    if (updates.defaultMarkupType !== undefined && !MARKUP_TYPES.includes(updates.defaultMarkupType)) {
      throw new Error(`defaultMarkupType must be one of: ${MARKUP_TYPES.join(', ')}`);
    }

    const allowed = [
      'trade',
      'category',
      'name',
      'unit',
      'defaultUnitCost',
      'defaultMarkupType',
      'defaultMarkupValue',
      'notes',
      'active'
    ];
    for (const key of allowed) {
      if (updates[key] !== undefined) item[key] = updates[key];
    }

    item.updatedAt = new Date().toISOString();
    return item;
  }

  /**
   * Soft-delete: catalog items are hidden (active: false) rather than
   * removed outright, and the ID stays valid for lookup. This never
   * affects estimates that already copied its values, but a hard delete
   * would also be harmless to past estimates -- soft delete purely keeps
   * "who deactivated what, and when" recoverable via update().
   */
  deactivate(tenantId, id) {
    return this.update(tenantId, id, { active: false });
  }

  delete(tenantId, id) {
    const store = getStore();
    const item = store.catalogItems.get(id);
    if (!item || item.tenantId !== tenantId) return false;
    store.catalogItems.delete(id);
    return true;
  }

  deleteAllForTenant(tenantId) {
    let count = 0;
    for (const item of this.listByTenant(tenantId, { includeInactive: true })) {
      this.delete(tenantId, item.id);
      count += 1;
    }
    return count;
  }
}

module.exports = new CatalogItemRepository();
module.exports.CatalogItemRepository = CatalogItemRepository;
