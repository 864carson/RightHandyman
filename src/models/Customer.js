const { randomUUID } = require('crypto');
const { getStore } = require('./db');

/** Strips everything but digits, keeping only the last 10 -- enough to
 * match "+15551234567", "(555) 123-4567", and "555-123-4567" as the same
 * number without needing a full phone-number-parsing library. */
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  return digits.slice(-10) || null;
}

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

  /**
   * Cross-tenant search by phone number, used to match an inbound SMS to
   * a customer (see controllers/messagingController.js) -- this app has
   * one global SMS_FROM_NUMBER shared by every tenant, not a number per
   * tenant, so an inbound text doesn't come with a tenant attached the way
   * every other request in this app does. Returns every match across
   * every tenant (ideally exactly one); the caller decides what to do if
   * that's zero or more than one. Compares normalized digits so "+1555…",
   * "(555) …", and "555-…" all match the same stored number.
   */
  findAllByPhone(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) return [];
    const store = getStore();
    return Array.from(store.customers.values()).filter((c) => normalizePhone(c.phone) === normalized);
  }
}

module.exports = new CustomerRepository();
module.exports.CustomerRepository = CustomerRepository;
module.exports.normalizePhone = normalizePhone;
