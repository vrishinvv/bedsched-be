import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveJwtSecret, resolveRequireBookingPhotos, resolveSaiConnectEventIds } from '../common/configs.js';

test('production authentication fails closed without JWT_SECRET', () => {
  assert.throws(
    () => resolveJwtSecret('production', undefined),
    /JWT_SECRET must be configured in production/,
  );
});

test('development can use the explicit local-only fallback', () => {
  assert.equal(resolveJwtSecret('development', undefined), 'dev-insecure-secret');
  assert.equal(resolveJwtSecret('production', 'configured-secret'), 'configured-secret');
});

test('uses event 14 for Sevadal and event 15 for Delegate by default', () => {
  assert.deepEqual(resolveSaiConnectEventIds(undefined, undefined), {
    delegateEventId: 15,
    sevadalEventId: 14,
  });
});

test('requires booking photos only for the production frontend unless explicitly configured', () => {
  assert.equal(resolveRequireBookingPhotos(undefined, 'https://sssenclave.vercel.app'), true);
  assert.equal(resolveRequireBookingPhotos(undefined, 'https://sssenclave-dev.vercel.app'), false);
  assert.equal(resolveRequireBookingPhotos('true', 'http://localhost:3000'), true);
  assert.equal(resolveRequireBookingPhotos('false', 'https://sssenclave.vercel.app'), false);
});
