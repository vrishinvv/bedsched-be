import test from 'node:test';
import assert from 'node:assert/strict';

import { runInTransaction } from '../common/transactions.js';

function createFakePool({ rollbackError } = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === 'ROLLBACK' && rollbackError) throw rollbackError;
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };

  return {
    pool: { async connect() { return client; } },
    client,
    calls,
    wasReleased: () => released,
  };
}

test('commits all work on the same checked-out client', async () => {
  const fake = createFakePool();

  const result = await runInTransaction(fake.pool, async (client) => {
    assert.equal(client, fake.client);
    await client.query('INSERT INTO example(value) VALUES ($1)', ['kept']);
    return 'done';
  });

  assert.equal(result, 'done');
  assert.deepEqual(fake.calls.map(({ sql }) => sql), [
    'BEGIN',
    'INSERT INTO example(value) VALUES ($1)',
    'COMMIT',
  ]);
  assert.equal(fake.wasReleased(), true);
});

test('rolls back and releases the client when an operation fails', async () => {
  const fake = createFakePool();
  const operationError = new Error('insert failed');

  await assert.rejects(
    runInTransaction(fake.pool, async (client) => {
      await client.query('UPDATE example SET value = $1', ['not-kept']);
      throw operationError;
    }),
    operationError,
  );

  assert.deepEqual(fake.calls.map(({ sql }) => sql), [
    'BEGIN',
    'UPDATE example SET value = $1',
    'ROLLBACK',
  ]);
  assert.equal(fake.wasReleased(), true);
});

test('preserves the original operation error if rollback also fails', async () => {
  const fake = createFakePool({ rollbackError: new Error('connection lost') });
  const operationError = new Error('write failed');

  await assert.rejects(
    runInTransaction(fake.pool, async () => {
      throw operationError;
    }),
    operationError,
  );
  assert.equal(fake.wasReleased(), true);
});

