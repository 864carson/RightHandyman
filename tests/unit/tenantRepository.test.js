const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');

describe('TenantRepository', () => {
  beforeEach(() => reset());

  test('creates a tenant with a normalized slug', () => {
    const tenant = TenantRepository.create({ name: 'Acme Inc', slug: 'ACME' });

    expect(tenant.id).toBeDefined();
    expect(tenant.name).toBe('Acme Inc');
    expect(tenant.slug).toBe('acme');
  });

  test('rejects duplicate slugs', () => {
    TenantRepository.create({ name: 'Acme Inc', slug: 'acme' });

    expect(() => TenantRepository.create({ name: 'Acme Clone', slug: 'acme' })).toThrow(
      /already in use/
    );
  });

  test('rejects creation without name or slug', () => {
    expect(() => TenantRepository.create({ name: '', slug: 'acme' })).toThrow();
    expect(() => TenantRepository.create({ name: 'Acme', slug: '' })).toThrow();
  });

  test('finds a tenant by id and by slug', () => {
    const created = TenantRepository.create({ name: 'Acme Inc', slug: 'acme' });

    expect(TenantRepository.findById(created.id)).toEqual(created);
    expect(TenantRepository.findBySlug('acme')).toEqual(created);
    expect(TenantRepository.findBySlug('ACME')).toEqual(created);
  });

  test('returns null for unknown id/slug', () => {
    expect(TenantRepository.findById('missing')).toBeNull();
    expect(TenantRepository.findBySlug('missing')).toBeNull();
  });

  test('lists all tenants', () => {
    TenantRepository.create({ name: 'A', slug: 'a' });
    TenantRepository.create({ name: 'B', slug: 'b' });

    expect(TenantRepository.list()).toHaveLength(2);
  });

  test('update() changes name and slug', () => {
    const tenant = TenantRepository.create({ name: 'Acme Inc', slug: 'acme' });
    const updated = TenantRepository.update(tenant.id, { name: 'Acme Corp', slug: 'acme-corp' });

    expect(updated.name).toBe('Acme Corp');
    expect(updated.slug).toBe('acme-corp');
    expect(TenantRepository.findBySlug('acme')).toBeNull();
    expect(TenantRepository.findBySlug('acme-corp')).toEqual(updated);
  });

  test('update() rejects a slug already used by another tenant', () => {
    TenantRepository.create({ name: 'Acme', slug: 'acme' });
    const other = TenantRepository.create({ name: 'Other', slug: 'other' });

    expect(() => TenantRepository.update(other.id, { slug: 'acme' })).toThrow(/already in use/);
  });

  test('update() throws for an unknown tenant', () => {
    expect(() => TenantRepository.update('missing', { name: 'X' })).toThrow(/not found/i);
  });

  test('remove() deletes a tenant and frees its slug', () => {
    const tenant = TenantRepository.create({ name: 'Acme', slug: 'acme' });

    expect(TenantRepository.remove(tenant.id)).toBe(true);
    expect(TenantRepository.findById(tenant.id)).toBeNull();
    expect(TenantRepository.findBySlug('acme')).toBeNull();
  });

  test('remove() returns false for an unknown tenant', () => {
    expect(TenantRepository.remove('missing')).toBe(false);
  });
});
