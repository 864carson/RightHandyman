const { reset } = require('../../src/models/db');
const TenantRepository = require('../../src/models/Tenant');
const UserRepository = require('../../src/models/User');

describe('UserRepository', () => {
  let tenantA;
  let tenantB;

  beforeEach(() => {
    reset();
    tenantA = TenantRepository.create({ name: 'Tenant A', slug: 'tenant-a' });
    tenantB = TenantRepository.create({ name: 'Tenant B', slug: 'tenant-b' });
  });

  test('creates a user scoped to a tenant', () => {
    const user = UserRepository.create({
      tenantId: tenantA.id,
      provider: 'google',
      providerId: 'g-1',
      email: 'Jane@Example.com',
      displayName: 'Jane'
    });

    expect(user.id).toBeDefined();
    expect(user.tenantId).toBe(tenantA.id);
    expect(user.email).toBe('jane@example.com'); // normalized
  });

  test('rejects creation when required fields are missing', () => {
    expect(() =>
      UserRepository.create({ tenantId: tenantA.id, provider: 'google', providerId: 'g-1' })
    ).toThrow(/required/);
  });

  test('finds a user by provider identity within a tenant', () => {
    const created = UserRepository.create({
      tenantId: tenantA.id,
      provider: 'google',
      providerId: 'g-1',
      email: 'jane@example.com'
    });

    const found = UserRepository.findByProviderId(tenantA.id, 'google', 'g-1');
    expect(found).toEqual(created);
  });

  test('finds a user by email within a tenant', () => {
    const created = UserRepository.create({
      tenantId: tenantA.id,
      provider: 'google',
      providerId: 'g-1',
      email: 'jane@example.com'
    });

    expect(UserRepository.findByEmail(tenantA.id, 'JANE@example.com')).toEqual(created);
  });

  test('same email/provider identity in two tenants creates two distinct users', () => {
    const userInA = UserRepository.create({
      tenantId: tenantA.id,
      provider: 'google',
      providerId: 'g-1',
      email: 'jane@example.com'
    });

    const userInB = UserRepository.create({
      tenantId: tenantB.id,
      provider: 'google',
      providerId: 'g-1',
      email: 'jane@example.com'
    });

    expect(userInA.id).not.toBe(userInB.id);
    expect(UserRepository.findByProviderId(tenantA.id, 'google', 'g-1').id).toBe(userInA.id);
    expect(UserRepository.findByProviderId(tenantB.id, 'google', 'g-1').id).toBe(userInB.id);
  });

  test('findById returns null when the user belongs to a different tenant', () => {
    const userInA = UserRepository.create({
      tenantId: tenantA.id,
      provider: 'google',
      providerId: 'g-1',
      email: 'jane@example.com'
    });

    expect(UserRepository.findById(tenantB.id, userInA.id)).toBeNull();
    expect(UserRepository.findById(tenantA.id, userInA.id)).toEqual(userInA);
  });

  test('listByTenant only returns users for that tenant', () => {
    UserRepository.create({ tenantId: tenantA.id, provider: 'google', providerId: 'g-1', email: 'a@example.com' });
    UserRepository.create({ tenantId: tenantA.id, provider: 'google', providerId: 'g-2', email: 'b@example.com' });
    UserRepository.create({ tenantId: tenantB.id, provider: 'google', providerId: 'g-3', email: 'c@example.com' });

    expect(UserRepository.listByTenant(tenantA.id)).toHaveLength(2);
    expect(UserRepository.listByTenant(tenantB.id)).toHaveLength(1);
  });

  test('countByTenant counts only that tenant', () => {
    UserRepository.create({ tenantId: tenantA.id, provider: 'google', providerId: 'g-1', email: 'a@example.com' });
    UserRepository.create({ tenantId: tenantB.id, provider: 'google', providerId: 'g-2', email: 'b@example.com' });

    expect(UserRepository.countByTenant(tenantA.id)).toBe(1);
  });

  test('create() rejects a duplicate email within the same tenant', () => {
    UserRepository.create({ tenantId: tenantA.id, provider: 'google', providerId: 'g-1', email: 'jane@example.com' });

    expect(() =>
      UserRepository.create({ tenantId: tenantA.id, provider: 'github', providerId: 'gh-1', email: 'jane@example.com' })
    ).toThrow(/already exists/);
  });

  test('create() allows a user with no provider yet (pending invite)', () => {
    const invited = UserRepository.create({ tenantId: tenantA.id, email: 'invitee@example.com', status: 'invited' });

    expect(invited.status).toBe('invited');
    expect(invited.provider).toBeNull();
    expect(UserRepository.findByEmail(tenantA.id, 'invitee@example.com')).toEqual(invited);
  });

  test('update() changes displayName, avatarUrl, role, and status', () => {
    const user = UserRepository.create({
      tenantId: tenantA.id,
      provider: 'google',
      providerId: 'g-1',
      email: 'jane@example.com'
    });

    const updated = UserRepository.update(tenantA.id, user.id, {
      displayName: 'Jane Updated',
      avatarUrl: 'http://example.com/a.png',
      role: 'admin',
      status: 'active'
    });

    expect(updated.displayName).toBe('Jane Updated');
    expect(updated.role).toBe('admin');
  });

  test('update() rejects an invalid role', () => {
    const user = UserRepository.create({ tenantId: tenantA.id, provider: 'google', providerId: 'g-1', email: 'a@example.com' });
    expect(() => UserRepository.update(tenantA.id, user.id, { role: 'superadmin' })).toThrow(/role must be one of/);
  });

  test('update() returns null for a user in a different tenant', () => {
    const user = UserRepository.create({ tenantId: tenantA.id, provider: 'google', providerId: 'g-1', email: 'a@example.com' });
    expect(UserRepository.update(tenantB.id, user.id, { displayName: 'X' })).toBeNull();
  });

  test('update() re-indexes email when it changes', () => {
    const user = UserRepository.create({ tenantId: tenantA.id, provider: 'google', providerId: 'g-1', email: 'old@example.com' });
    UserRepository.update(tenantA.id, user.id, { email: 'new@example.com' });

    expect(UserRepository.findByEmail(tenantA.id, 'old@example.com')).toBeNull();
    expect(UserRepository.findByEmail(tenantA.id, 'new@example.com').id).toBe(user.id);
  });

  test('linkProviderIdentity attaches a new provider and activates a pending invite', () => {
    const invited = UserRepository.create({ tenantId: tenantA.id, email: 'invitee@example.com', status: 'invited' });

    const linked = UserRepository.linkProviderIdentity(tenantA.id, invited.id, {
      provider: 'google',
      providerId: 'g-99',
      displayName: 'Invitee Name'
    });

    expect(linked.status).toBe('active');
    expect(linked.provider).toBe('google');
    expect(UserRepository.findByProviderId(tenantA.id, 'google', 'g-99').id).toBe(invited.id);
  });

  test('delete() removes a user and its indexes', () => {
    const user = UserRepository.create({ tenantId: tenantA.id, provider: 'google', providerId: 'g-1', email: 'jane@example.com' });

    expect(UserRepository.delete(tenantA.id, user.id)).toBe(true);
    expect(UserRepository.findById(tenantA.id, user.id)).toBeNull();
    expect(UserRepository.findByEmail(tenantA.id, 'jane@example.com')).toBeNull();
    expect(UserRepository.findByProviderId(tenantA.id, 'google', 'g-1')).toBeNull();
  });

  test('delete() returns false for a user in a different tenant', () => {
    const user = UserRepository.create({ tenantId: tenantA.id, provider: 'google', providerId: 'g-1', email: 'jane@example.com' });
    expect(UserRepository.delete(tenantB.id, user.id)).toBe(false);
  });

  test('deleteAllForTenant removes every user for that tenant only', () => {
    UserRepository.create({ tenantId: tenantA.id, provider: 'google', providerId: 'g-1', email: 'a@example.com' });
    UserRepository.create({ tenantId: tenantA.id, provider: 'google', providerId: 'g-2', email: 'b@example.com' });
    UserRepository.create({ tenantId: tenantB.id, provider: 'google', providerId: 'g-3', email: 'c@example.com' });

    const count = UserRepository.deleteAllForTenant(tenantA.id);

    expect(count).toBe(2);
    expect(UserRepository.listByTenant(tenantA.id)).toHaveLength(0);
    expect(UserRepository.listByTenant(tenantB.id)).toHaveLength(1);
  });
});
