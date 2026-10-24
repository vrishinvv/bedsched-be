import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

import { runInTransaction } from '../common/transactions.js';

const shouldRun = process.env.RUN_DATABASE_INTEGRATION === 'true';

test('real PostgreSQL commits successful work and rolls back failed work', { skip: !shouldRun }, async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required for integration tests');

  const databaseUrl = new URL(process.env.TEST_DATABASE_URL);
  const isLocalDatabase = ['localhost', '127.0.0.1'].includes(databaseUrl.hostname);
  const pool = new pg.Pool({
    connectionString: databaseUrl.toString(),
    ssl: isLocalDatabase ? false : { rejectUnauthorized: false },
    max: 2,
  });
  const schema = `bedsched_test_${crypto.randomBytes(8).toString('hex')}`;
  const qualifiedTable = `"${schema}".transaction_probe`;

  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`CREATE TABLE ${qualifiedTable} (id integer PRIMARY KEY, value text NOT NULL)`);

    await runInTransaction(pool, async (client) => {
      await client.query(`INSERT INTO ${qualifiedTable} (id, value) VALUES ($1, $2)`, [1, 'committed']);
    });

    await assert.rejects(
      runInTransaction(pool, async (client) => {
        await client.query(`INSERT INTO ${qualifiedTable} (id, value) VALUES ($1, $2)`, [2, 'rolled-back']);
        throw new Error('force rollback');
      }),
      /force rollback/,
    );

    const result = await pool.query(`SELECT id, value FROM ${qualifiedTable} ORDER BY id`);
    assert.deepEqual(result.rows, [{ id: 1, value: 'committed' }]);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});
