const { reset } = require('../../src/models/db');
const RolePermissions = require('../../src/models/RolePermissions');
const { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } = require('../../src/config/permissions');

describe('RolePermissionsRepository', () => {
  beforeEach(() => reset());

  test('returns built-in defaults when no override exists', () => {
    expect(RolePermissions.getEffectivePermissions('t1', 'member')).toEqual(DEFAULT_ROLE_PERMISSIONS.member);
    expect(RolePermissions.getEffectivePermissions('t1', 'owner')).toEqual(DEFAULT_ROLE_PERMISSIONS.owner);
  });

  test('returns an empty array for an unknown role', () => {
    expect(RolePermissions.getEffectivePermissions('t1', 'bogus')).toEqual([]);
  });

  test('setOverride replaces the effective permission set for that tenant+role only', () => {
    RolePermissions.setOverride('t1', 'member', [PERMISSIONS.CUSTOMERS_READ]);

    expect(RolePermissions.getEffectivePermissions('t1', 'member')).toEqual([PERMISSIONS.CUSTOMERS_READ]);
    // A different tenant is unaffected.
    expect(RolePermissions.getEffectivePermissions('t2', 'member')).toEqual(DEFAULT_ROLE_PERMISSIONS.member);
    // A different role in the same tenant is unaffected.
    expect(RolePermissions.getEffectivePermissions('t1', 'admin')).toEqual(DEFAULT_ROLE_PERMISSIONS.admin);
  });

  test('setOverride rejects an unknown role', () => {
    expect(() => RolePermissions.setOverride('t1', 'superadmin', [])).toThrow(/role must be one of/);
  });

  test('setOverride rejects a non-array permissions value', () => {
    expect(() => RolePermissions.setOverride('t1', 'member', 'not-an-array')).toThrow(/must be an array/);
  });

  test('setOverride rejects unknown permission strings', () => {
    expect(() => RolePermissions.setOverride('t1', 'member', ['not:a:real:permission'])).toThrow(/Unknown permission/);
  });

  test('setOverride dedupes repeated permissions', () => {
    const result = RolePermissions.setOverride('t1', 'member', [
      PERMISSIONS.CUSTOMERS_READ,
      PERMISSIONS.CUSTOMERS_READ
    ]);
    expect(result).toEqual([PERMISSIONS.CUSTOMERS_READ]);
  });

  test('clearOverride reverts to the built-in default', () => {
    RolePermissions.setOverride('t1', 'member', [PERMISSIONS.CUSTOMERS_READ]);
    expect(RolePermissions.clearOverride('t1', 'member')).toBe(true);
    expect(RolePermissions.getEffectivePermissions('t1', 'member')).toEqual(DEFAULT_ROLE_PERMISSIONS.member);
  });

  test('clearOverride returns false when there was nothing to clear', () => {
    expect(RolePermissions.clearOverride('t1', 'member')).toBe(false);
  });

  test('getEffectiveMatrix returns every role\'s effective permissions', () => {
    RolePermissions.setOverride('t1', 'member', [PERMISSIONS.CUSTOMERS_READ]);
    const matrix = RolePermissions.getEffectiveMatrix('t1');

    expect(matrix.member).toEqual([PERMISSIONS.CUSTOMERS_READ]);
    expect(matrix.admin).toEqual(DEFAULT_ROLE_PERMISSIONS.admin);
    expect(matrix.owner).toEqual(DEFAULT_ROLE_PERMISSIONS.owner);
  });

  test('clearAllForTenant removes every override for that tenant', () => {
    RolePermissions.setOverride('t1', 'member', [PERMISSIONS.CUSTOMERS_READ]);
    RolePermissions.setOverride('t1', 'admin', [PERMISSIONS.CUSTOMERS_READ]);

    RolePermissions.clearAllForTenant('t1');

    expect(RolePermissions.getEffectivePermissions('t1', 'member')).toEqual(DEFAULT_ROLE_PERMISSIONS.member);
    expect(RolePermissions.getEffectivePermissions('t1', 'admin')).toEqual(DEFAULT_ROLE_PERMISSIONS.admin);
  });
});
