const { randomUUID } = require('crypto');
const { getStore } = require('./db');

class TenantRepository {
  /**
   * @param {{name: string, slug: string}} data
   */
  create({ name, slug }) {
    const store = getStore();

    if (!name || !slug) {
      throw new Error('Tenant requires both a name and a slug');
    }

    const normalizedSlug = slug.trim().toLowerCase();

    if (store.tenantsBySlug.has(normalizedSlug)) {
      throw new Error(`Tenant slug "${normalizedSlug}" is already in use`);
    }

    const tenant = {
      id: randomUUID(),
      name,
      slug: normalizedSlug,
      createdAt: new Date().toISOString()
    };

    store.tenants.set(tenant.id, tenant);
    store.tenantsBySlug.set(normalizedSlug, tenant.id);

    return tenant;
  }

  findById(id) {
    const store = getStore();
    return store.tenants.get(id) || null;
  }

  findBySlug(slug) {
    if (!slug) return null;
    const store = getStore();
    const id = store.tenantsBySlug.get(slug.trim().toLowerCase());
    return id ? store.tenants.get(id) : null;
  }

  list() {
    const store = getStore();
    return Array.from(store.tenants.values());
  }

  /** Partial update. Only name and slug are mutable; slug must stay unique. */
  update(id, { name, slug } = {}) {
    const store = getStore();
    const tenant = store.tenants.get(id);
    if (!tenant) {
      throw new Error('Tenant not found');
    }

    if (slug !== undefined) {
      const normalizedSlug = slug.trim().toLowerCase();
      const existingId = store.tenantsBySlug.get(normalizedSlug);
      if (existingId && existingId !== id) {
        throw new Error(`Tenant slug "${normalizedSlug}" is already in use`);
      }
      store.tenantsBySlug.delete(tenant.slug);
      store.tenantsBySlug.set(normalizedSlug, id);
      tenant.slug = normalizedSlug;
    }

    if (name !== undefined) {
      tenant.name = name;
    }

    tenant.updatedAt = new Date().toISOString();
    return tenant;
  }

  /** Deletes a tenant record. Does NOT cascade -- callers should remove members first. */
  remove(id) {
    const store = getStore();
    const tenant = store.tenants.get(id);
    if (!tenant) return false;

    store.tenants.delete(id);
    store.tenantsBySlug.delete(tenant.slug);
    return true;
  }
}

module.exports = new TenantRepository();
module.exports.TenantRepository = TenantRepository;
