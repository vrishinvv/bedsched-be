import test from 'node:test';
import assert from 'node:assert/strict';
import { canViewAnalytics, isDashboardApiRequestAllowed } from '../common/rolePermissions.js';

test('analytics is available to admin and dashboard roles only', () => {
  assert.equal(canViewAnalytics({ role: 'admin' }), true);
  assert.equal(canViewAnalytics({ role: 'dashboard' }), true);
  assert.equal(canViewAnalytics({ role: 'location_user' }), false);
  assert.equal(canViewAnalytics(null), false);
});

test('dashboard API access includes read-only analytics and existing dashboard actions', () => {
  assert.equal(isDashboardApiRequestAllowed('GET', '/api/admin/analytics'), true);
  assert.equal(isDashboardApiRequestAllowed('GET', '/api/locations'), true);
  assert.equal(isDashboardApiRequestAllowed('GET', '/api/locations/61/tents'), true);
  assert.equal(isDashboardApiRequestAllowed('GET', '/api/locations/61/tents/2/blocks'), true);
  assert.equal(isDashboardApiRequestAllowed('POST', '/api/allocations/smart-reserve'), true);
  assert.equal(isDashboardApiRequestAllowed('GET', '/api/room-status'), true);
});

test('dashboard API access does not grant analytics writes or other admin actions', () => {
  assert.equal(isDashboardApiRequestAllowed('POST', '/api/admin/analytics'), false);
  assert.equal(isDashboardApiRequestAllowed('PATCH', '/api/locations/61/tents/2/blocks'), false);
  assert.equal(isDashboardApiRequestAllowed('GET', '/api/locations/61/tents/2/blocks/3'), false);
  assert.equal(isDashboardApiRequestAllowed('GET', '/api/admin/users'), false);
  assert.equal(isDashboardApiRequestAllowed('GET', '/api/allocations'), false);
  assert.equal(isDashboardApiRequestAllowed('PATCH', '/api/room-status/123/state'), false);
});
