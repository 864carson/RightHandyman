const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const CatalogItemRepository = require('../../src/models/CatalogItem');

describe('CatalogItemRepository', () => {
  let tenantA;
  let tenantB;

  beforeEach(() => {
    reset();
    tenantA = TenantRepository.create({ name: 'Tenant A', slug: 'tenant-a' });
    tenantB = TenantRepository.create({ name: 'Tenant B', slug: 'tenant-b' });
  });

  test('creates a catalog item, defaulting markup % by category', () => {
    const materials = CatalogItemRepository.create({
      tenantId: tenantA.id,
      trade: 'landscaping',
      category: 'materials',
      name: 'Mulch, bulk yard',
      unit: 'yard',
      defaultUnitCost: 28
    });
    const labor = CatalogItemRepository.create({
      tenantId: tenantA.id,
      trade: 'landscaping',
      category: 'labor',
      name: 'Crew labor',
      unit: 'hour',
      defaultUnitCost: 22
    });

    expect(materials.defaultMarkupValue).toBe(30);
    expect(materials.defaultMarkupType).toBe('percent');
    expect(labor.defaultMarkupValue).toBe(50);
    expect(materials.active).toBe(true);
  });

  test('rejects creation without tenantId, trade, name, or unit', () => {
    expect(() => CatalogItemRepository.create({ trade: 'landscaping', name: 'X', unit: 'each' })).toThrow(/required/);
    expect(() => CatalogItemRepository.create({ tenantId: tenantA.id, name: 'X', unit: 'each' })).toThrow(/required/);
    expect(() => CatalogItemRepository.create({ tenantId: tenantA.id, trade: 'landscaping', unit: 'each' })).toThrow(/required/);
    expect(() => CatalogItemRepository.create({ tenantId: tenantA.id, trade: 'landscaping', name: 'X' })).toThrow(/required/);
  });

  test('rejects an invalid category or markup type', () => {
    expect(() =>
      CatalogItemRepository.create({ tenantId: tenantA.id, trade: 'landscaping', name: 'X', unit: 'each', category: 'bogus' })
    ).toThrow(/category must be one of/);
    expect(() =>
      CatalogItemRepository.create({
        tenantId: tenantA.id,
        trade: 'landscaping',
        name: 'X',
        unit: 'each',
        defaultMarkupType: 'bogus'
      })
    ).toThrow(/defaultMarkupType must be one of/);
  });

  test('findById scopes to tenant', () => {
    const item = CatalogItemRepository.create({ tenantId: tenantA.id, trade: 'landscaping', name: 'X', unit: 'each' });
    expect(CatalogItemRepository.findById(tenantB.id, item.id)).toBeNull();
    expect(CatalogItemRepository.findById(tenantA.id, item.id)).not.toBeNull();
  });

  test('listByTenant filters by trade and category', () => {
    CatalogItemRepository.create({ tenantId: tenantA.id, trade: 'landscaping', category: 'materials', name: 'Mulch', unit: 'yard' });
    CatalogItemRepository.create({ tenantId: tenantA.id, trade: 'landscaping', category: 'labor', name: 'Crew', unit: 'hour' });
    CatalogItemRepository.create({ tenantId: tenantA.id, trade: 'drainage', category: 'materials', name: 'Pipe', unit: 'linear foot' });

    expect(CatalogItemRepository.listByTenant(tenantA.id)).toHaveLength(3);
    expect(CatalogItemRepository.listByTenant(tenantA.id, { trade: 'landscaping' })).toHaveLength(2);
    expect(CatalogItemRepository.listByTenant(tenantA.id, { trade: 'landscaping', category: 'labor' })).toHaveLength(1);
  });

  test('update() changes mutable fields and validates category/markupType', () => {
    const item = CatalogItemRepository.create({ tenantId: tenantA.id, trade: 'landscaping', name: 'Mulch', unit: 'yard', defaultUnitCost: 28 });
    const updated = CatalogItemRepository.update(tenantA.id, item.id, { defaultUnitCost: 32 });
    expect(updated.defaultUnitCost).toBe(32);
    expect(() => CatalogItemRepository.update(tenantA.id, item.id, { category: 'bogus' })).toThrow(/category must be one of/);
  });

  test('deactivate() hides the item from default listings without deleting it', () => {
    const item = CatalogItemRepository.create({ tenantId: tenantA.id, trade: 'landscaping', name: 'Mulch', unit: 'yard' });
    CatalogItemRepository.deactivate(tenantA.id, item.id);

    expect(CatalogItemRepository.listByTenant(tenantA.id)).toHaveLength(0);
    expect(CatalogItemRepository.listByTenant(tenantA.id, { includeInactive: true })).toHaveLength(1);
    expect(CatalogItemRepository.findById(tenantA.id, item.id).active).toBe(false);
  });

  test('deleteAllForTenant removes only that tenant\'s items, including inactive ones', () => {
    const itemA = CatalogItemRepository.create({ tenantId: tenantA.id, trade: 'landscaping', name: 'Mulch', unit: 'yard' });
    CatalogItemRepository.deactivate(tenantA.id, itemA.id);
    CatalogItemRepository.create({ tenantId: tenantB.id, trade: 'landscaping', name: 'Mulch', unit: 'yard' });

    const count = CatalogItemRepository.deleteAllForTenant(tenantA.id);

    expect(count).toBe(1);
    expect(CatalogItemRepository.listByTenant(tenantA.id, { includeInactive: true })).toHaveLength(0);
    expect(CatalogItemRepository.listByTenant(tenantB.id)).toHaveLength(1);
  });
});
