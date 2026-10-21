import test from 'node:test';
import assert from 'node:assert/strict';

import { isCronAuthorized, isSeedAllowed } from '../common/runtimeGuards.js';

test('disables database seeding in production', () => {
  assert.equal(isSeedAllowed('production'), false);
});

test('allows database seeding in non-production environments', () => {
  assert.equal(isSeedAllowed('development'), true);
  assert.equal(isSeedAllowed('test'), true);
  assert.equal(isSeedAllowed(undefined), true);
});

test('requires the configured cron secret in production', () => {
  assert.equal(isCronAuthorized('production', 'Bearer correct-secret', 'correct-secret'), true);
  assert.equal(isCronAuthorized('production', 'Bearer wrong-secret', 'correct-secret'), false);
  assert.equal(isCronAuthorized('production', undefined, 'correct-secret'), false);
  assert.equal(isCronAuthorized('production', 'Bearer dev-secret', undefined), false);
});

test('allows local cron testing outside production', () => {
  assert.equal(isCronAuthorized('development', undefined, undefined), true);
});
