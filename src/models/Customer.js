const { randomUUID } = require('crypto');
const { getStore } = require('./db');

class CustomerRepository {
  create({ tenantId, name, email, phone, company, notes, createdBy }) {
    if (!tenantId || !name) {
      throw new Error('tenantId and name are required to create a customer');
    }

    const store = getStore();
    const customer = {
      id: randomUUID(),
      tenantId,
      name,
      email: email ? email.trim().toLowerCase() : null,
      phone: phone || null,
      company: company || null,
      notes: notes || null,
      createdBy: createdBy || null,
      createdAt: new Date().toISOString()
    };

    store.customers.set(customer.id, customer);
    return customer;
  }

  findById(tenantId, id) {
    const store = getStore();
    const customer = store.customers.get(id);
    if (!customer || customer.tenantId !== tenantId) return null;
    return customer;
  }

  listByTenant(tenantId) {
    const store = getStore();
    return Array.from(store.customers.values()).filter((c) => c.tenantId === tenantId);
  }

  /** Partial update. Only name, email, phone, company, and notes are mutable. */
  update(tenantId, id, updates = {}) {
    const store = getStore();
    const customer = store.customers.get(id);
    if (!customer || customer.tenantId !== tenantId) return null;

    if (updates.name !== undefined) customer.name = updates.name;
    if (updates.email !== undefined) {
      customer.email = updates.email ? updates.email.trim().toLowerCase() : null;
    }
    if (updates.phone !== undefined) customer.phone = updates.phone;
    if (updates.company !== undefined) customer.company = updates.company;
    if (updates.notes !== undefined) customer.notes = updates.notes;

    customer.updatedAt = new Date().toISOString();
    return customer;
  }

  delete(tenantId, id) {
    const store = getStore();
    const customer = store.customers.get(id);
    if (!customer || customer.tenantId !== tenantId) return false;
    store.customers.delete(id);
    return true;
  }

  /** Removes every customer in a tenant. Used when a tenant itself is deleted. */
  deleteAllForTenant(tenantId) {
    let count = 0;
    for (const customer of this.listByTenant(tenantId)) {
      this.delete(tenantId, customer.id);
      count += 1;
    }
    return count;
  }
}

module.exports = new CustomerRepository();
module.exports.CustomerRepository = CustomerRepository;
