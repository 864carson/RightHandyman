const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const EstimateTemplateRepository = require('../../src/models/EstimateTemplate');

const basicLineItems = [
  { description: 'Mow + edge', category: 'labor', unit: 'visit', defaultQuantity: 1, defaultUnitCost: 35, markupType: 'percent', markupValue: 50 }
];

describe('EstimateTemplateRepository', () => {
  let tenantA;
  let tenantB;

  beforeEach(() => {
    reset();
    tenantA = TenantRepository.create({ name: 'Tenant A', slug: 'tenant-a' });
    tenantB = TenantRepository.create({ name: 'Tenant B', slug: 'tenant-b' });
  });

  test('creates a template with normalized line items', () => {
    const template = EstimateTemplateRepository.create({
      tenantId: tenantA.id,
      trade: 'landscaping',
      name: 'Weekly mow + edge',
      lineItems: basicLineItems
    });

    expect(template.id).toBeDefined();
    expect(template.active).toBe(true);
    expect(template.lineItems).toHaveLength(1);
    expect(template.lineItems[0].defaultQuantity).toBe(1);
  });

  test('rejects creation without tenantId, trade, or name', () => {
    expect(() => EstimateTemplateRepository.create({ trade: 'landscaping', name: 'X', lineItems: basicLineItems })).toThrow(/required/);
    expect(() => EstimateTemplateRepository.create({ tenantId: tenantA.id, name: 'X', lineItems: basicLineItems })).toThrow(/required/);
    expect(() => EstimateTemplateRepository.create({ tenantId: tenantA.id, trade: 'landscaping', lineItems: basicLineItems })).toThrow(/required/);
  });

  test('rejects an empty or missing lineItems array', () => {
    expect(() => EstimateTemplateRepository.create({ tenantId: tenantA.id, trade: 'landscaping', name: 'X', lineItems: [] })).toThrow(
      /non-empty array/
    );
    expect(() => EstimateTemplateRepository.create({ tenantId: tenantA.id, trade: 'landscaping', name: 'X' })).toThrow(/non-empty array/);
  });

  test('rejects a line item missing description or unit', () => {
    expect(() =>
      EstimateTemplateRepository.create({
        tenantId: tenantA.id,
        trade: 'landscaping',
        name: 'X',
        lineItems: [{ category: 'labor', unit: 'hour' }]
      })
    ).toThrow(/description/);
    expect(() =>
      EstimateTemplateRepository.create({
        tenantId: tenantA.id,
        trade: 'landscaping',
        name: 'X',
        lineItems: [{ description: 'Labor' }]
      })
    ).toThrow(/unit/);
  });

  test('findById scopes to tenant', () => {
    const template = EstimateTemplateRepository.create({ tenantId: tenantA.id, trade: 'landscaping', name: 'X', lineItems: basicLineItems });
    expect(EstimateTemplateRepository.findById(tenantB.id, template.id)).toBeNull();
  });

  test('listByTenant filters by trade and active state', () => {
    EstimateTemplateRepository.create({ tenantId: tenantA.id, trade: 'landscaping', name: 'A', lineItems: basicLineItems });
    const drainage = EstimateTemplateRepository.create({ tenantId: tenantA.id, trade: 'drainage', name: 'B', lineItems: basicLineItems });
    EstimateTemplateRepository.update(tenantA.id, drainage.id, { active: false });

    expect(EstimateTemplateRepository.listByTenant(tenantA.id)).toHaveLength(1);
    expect(EstimateTemplateRepository.listByTenant(tenantA.id, { includeInactive: true })).toHaveLength(2);
    expect(EstimateTemplateRepository.listByTenant(tenantA.id, { trade: 'drainage', includeInactive: true })).toHaveLength(1);
  });

  test('update() replaces and re-validates lineItems', () => {
    const template = EstimateTemplateRepository.create({ tenantId: tenantA.id, trade: 'landscaping', name: 'X', lineItems: basicLineItems });
    expect(() => EstimateTemplateRepository.update(tenantA.id, template.id, { lineItems: [] })).toThrow(/non-empty array/);

    const updated = EstimateTemplateRepository.update(tenantA.id, template.id, {
      lineItems: [{ description: 'New line', unit: 'each', defaultQuantity: 2 }]
    });
    expect(updated.lineItems).toHaveLength(1);
    expect(updated.lineItems[0].description).toBe('New line');
  });

  test('delete() and deleteAllForTenant scope correctly', () => {
    const template = EstimateTemplateRepository.create({ tenantId: tenantA.id, trade: 'landscaping', name: 'X', lineItems: basicLineItems });
    EstimateTemplateRepository.create({ tenantId: tenantB.id, trade: 'landscaping', name: 'Y', lineItems: basicLineItems });

    expect(EstimateTemplateRepository.delete(tenantB.id, template.id)).toBe(false);
    expect(EstimateTemplateRepository.delete(tenantA.id, template.id)).toBe(true);

    const count = EstimateTemplateRepository.deleteAllForTenant(tenantB.id);
    expect(count).toBe(1);
  });
});
