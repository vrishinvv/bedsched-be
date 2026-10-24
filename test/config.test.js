import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveJwtSecret } from '../common/configs.js';

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
