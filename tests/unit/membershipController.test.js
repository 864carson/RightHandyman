const { resetWithTenant } = require('../helpers/setup');
const { inviteMember, removeMember } = require('../../src/controllers/membershipController');
const UserRepository = require('../../src/models/User');

describe('membershipController.inviteMember', () => {
  let tenant;

  beforeEach(() => {
    tenant = resetWithTenant();
  });

  test('creates a pending member with default role', () => {
    const member = inviteMember(tenant.id, { email: 'new@example.com' });

    expect(member.status).toBe('invited');
    expect(member.role).toBe('member');
    expect(member.provider).toBeNull();
  });

  test('accepts a custom role', () => {
    const member = inviteMember(tenant.id, { email: 'admin@example.com', role: 'admin' });
    expect(member.role).toBe('admin');
  });

  test('throws 400 when email is missing', () => {
    try {
      inviteMember(tenant.id, {});
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.status).toBe(400);
    }
  });

  test('throws 400 for an invalid role', () => {
    try {
      inviteMember(tenant.id, { email: 'x@example.com', role: 'superadmin' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.status).toBe(400);
    }
  });

  test('throws 409 when the email is already a member', () => {
    inviteMember(tenant.id, { email: 'dup@example.com' });

    try {
      inviteMember(tenant.id, { email: 'dup@example.com' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.status).toBe(409);
    }
  });
});

describe('membershipController.removeMember', () => {
  let tenant;

  beforeEach(() => {
    tenant = resetWithTenant();
  });

  test('removes an existing member', () => {
    const member = UserRepository.create({ tenantId: tenant.id, provider: 'google', providerId: 'g-1', email: 'a@example.com' });

    expect(removeMember(tenant.id, member.id)).toBe(true);
    expect(UserRepository.findById(tenant.id, member.id)).toBeNull();
  });

  test('throws 404 for a member that does not exist', () => {
    try {
      removeMember(tenant.id, 'ghost-id');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.status).toBe(404);
    }
  });
});
