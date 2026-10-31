import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDatabaseSsl } from '../common/databaseConfig.js';

test('uses plain local PostgreSQL connections and TLS for hosted databases', () => {
  assert.equal(resolveDatabaseSsl('postgresql:///bedsched_test'), false);
  assert.equal(resolveDatabaseSsl('postgresql://postgres@127.0.0.1:5432/bedsched_test'), false);
  assert.deepEqual(resolveDatabaseSsl('postgresql://postgres@example.neon.tech/db'), { rejectUnauthorized: false });
});
