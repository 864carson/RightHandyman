const { randomUUID } = require('crypto');
const { getStore } = require('./db');

const VALID_STAGES = ['lead', 'qualified', 'proposal', 'won', 'lost'];

class OpportunityRepository {
  create({ tenantId, customerId, name, stage, amount, currency, closeDate, notes, createdBy }) {
    if (!tenantId || !customerId || !name) {
      throw new Error('tenantId, customerId, and name are required to create an opportunity');
    }
    if (stage !== undefined && !VALID_STAGES.includes(stage)) {
      throw new Error(`stage must be one of: ${VALID_STAGES.join(', ')}`);
    }
    if (amount !== undefined && amount !== null && typeof amount !== 'number') {
      throw new Error('amount must be a number');
    }

    const store = getStore();
    const opportunity = {
      id: randomUUID(),
      tenantId,
      customerId,
      name,
      stage: stage || 'lead',
      amount: typeof amount === 'number' ? amount : null,
      currency: currency || 'USD',
      closeDate: closeDate || null,
      notes: notes || null,
      createdBy: createdBy || null,
      createdAt: new Date().toISOString()
    };

    store.opportunities.set(opportunity.id, opportunity);
    return opportunity;
  }

  findById(tenantId, id) {
    const store = getStore();
    const opportunity = store.opportunities.get(id);
    if (!opportunity || opportunity.tenantId !== tenantId) return null;
    return opportunity;
  }

  listByTenant(tenantId) {
    const store = getStore();
    return Array.from(store.opportunities.values()).filter((o) => o.tenantId === tenantId);
  }

  listByCustomer(tenantId, customerId) {
    return this.listByTenant(tenantId).filter((o) => o.customerId === customerId);
  }

  /** Partial update. name, stage, amount, currency, closeDate, notes, and customerId are mutable. */
  update(tenantId, id, updates = {}) {
    const store = getStore();
    const opportunity = store.opportunities.get(id);
    if (!opportunity || opportunity.tenantId !== tenantId) return null;

    if (updates.stage !== undefined && !VALID_STAGES.includes(updates.stage)) {
      throw new Error(`stage must be one of: ${VALID_STAGES.join(', ')}`);
    }
    if (updates.amount !== undefined && updates.amount !== null && typeof updates.amount !== 'number') {
      throw new Error('amount must be a number');
    }

    const allowed = ['name', 'stage', 'amount', 'currency', 'closeDate', 'notes', 'customerId'];
    for (const key of allowed) {
      if (updates[key] !== undefined) opportunity[key] = updates[key];
    }

    opportunity.updatedAt = new Date().toISOString();
    return opportunity;
  }

  delete(tenantId, id) {
    const store = getStore();
    const opportunity = store.opportunities.get(id);
    if (!opportunity || opportunity.tenantId !== tenantId) return false;
    store.opportunities.delete(id);
    return true;
  }

  /** Removes every opportunity in a tenant. Used when a tenant itself is deleted. */
  deleteAllForTenant(tenantId) {
    let count = 0;
    for (const opportunity of this.listByTenant(tenantId)) {
      this.delete(tenantId, opportunity.id);
      count += 1;
    }
    return count;
  }

  /** Removes every opportunity for a customer. Used when that customer is deleted. */
  deleteAllForCustomer(tenantId, customerId) {
    let count = 0;
    for (const opportunity of this.listByCustomer(tenantId, customerId)) {
      this.delete(tenantId, opportunity.id);
      count += 1;
    }
    return count;
  }
}

module.exports = new OpportunityRepository();
module.exports.OpportunityRepository = OpportunityRepository;
module.exports.VALID_STAGES = VALID_STAGES;
