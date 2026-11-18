import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canAccessLocation,
  getAccessibleLocationIds,
  normalizeLocationIds,
  resolveLocationAccessScope,
} from '../common/locationAccess.js';

test('normalizes, deduplicates, and sorts location IDs', () => {
  assert.deepEqual(normalizeLocationIds(['9', 3, 9, '', null, -1]), [3, 9]);
});

test('location users may access every explicitly assigned location', () => {
  const user = { role: 'location_user', locationId: 3, locationIds: [3, 7, 9] };
  assert.deepEqual(getAccessibleLocationIds(user), [3, 7, 9]);
  assert.equal(canAccessLocation(user, 7), true);
  assert.equal(canAccessLocation(user, 8), false);
});

test('legacy single-location users remain restricted to their assigned location', () => {
  const user = { role: 'location_user', locationId: 12 };
  assert.equal(canAccessLocation(user, 12), true);
  assert.equal(canAccessLocation(user, 13), false);
});

test('scope resolution allows admins, validates requested locations, and scopes location users', () => {
  assert.deepEqual(resolveLocationAccessScope({ role: 'admin' }), {
    forbidden: false,
    locationIds: null,
  });
  assert.deepEqual(resolveLocationAccessScope({ role: 'admin' }, '4'), {
    forbidden: false,
    locationIds: [4],
  });
  assert.deepEqual(
    resolveLocationAccessScope({ role: 'location_user', locationIds: [4, 5, 6, 7] }, '6'),
    { forbidden: false, locationIds: [6] }
  );
  assert.equal(
    resolveLocationAccessScope({ role: 'location_user', locationIds: [4, 5, 6, 7] }, '8').forbidden,
    true
  );
});
