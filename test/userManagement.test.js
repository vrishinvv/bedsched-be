import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UserValidationError,
  hashPassword,
  isPasswordHash,
  validateCreateUserInput,
  verifyPassword,
} from '../common/userManagement.js';

test('normalizes a valid location user payload', () => {
  assert.deepEqual(
    validateCreateUserInput({
      username: '  anv_21  ',
      password: 'safe-password',
      role: 'location_user',
      locationId: '61',
    }),
    {
      username: 'anv_21',
      password: 'safe-password',
      role: 'location_user',
      locationId: 61,
    }
  );
});

test('allows global roles without a location', () => {
  for (const role of ['admin', 'dashboard']) {
    const result = validateCreateUserInput({
      username: `${role}.user`,
      password: 'safe-password',
      role,
    });
    assert.equal(result.locationId, null);
  }
});

test('requires a valid location for location users', () => {
  assert.throws(
    () => validateCreateUserInput({ username: 'anv_21', password: 'safe-password', role: 'location_user' }),
    (error) => error instanceof UserValidationError && error.code === 'location_required'
  );
});

test('rejects a location on a global role', () => {
  assert.throws(
    () => validateCreateUserInput({
      username: 'admin.user',
      password: 'safe-password',
      role: 'admin',
      locationId: 61,
    }),
    (error) => error instanceof UserValidationError && error.code === 'location_not_allowed'
  );
});

test('rejects unsafe usernames, invalid roles, and short passwords', () => {
  const cases = [
    [{ username: 'bad user', password: 'safe-password', role: 'dashboard' }, 'invalid_username'],
    [{ username: 'valid.user', password: 'short', role: 'dashboard' }, 'invalid_password'],
    [{ username: 'valid.user', password: 'safe-password', role: 'owner' }, 'invalid_role'],
  ];

  for (const [input, code] of cases) {
    assert.throws(
      () => validateCreateUserInput(input),
      (error) => error instanceof UserValidationError && error.code === code
    );
  }
});

test('rejects a null request body without throwing an internal error', () => {
  assert.throws(
    () => validateCreateUserInput(null),
    (error) => error instanceof UserValidationError && error.code === 'invalid_username'
  );
});

test('new password hashes verify while legacy plaintext remains compatible', async () => {
  const password = 'a-secure-password';
  const hash = await hashPassword(password);

  assert.equal(isPasswordHash(hash), true);
  assert.notEqual(hash, password);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword('incorrect', hash), false);
  assert.equal(await verifyPassword('legacy-password', 'legacy-password'), true);
  assert.equal(await verifyPassword('incorrect', 'legacy-password'), false);
  assert.equal(await verifyPassword(12345678, hash), false);
});
