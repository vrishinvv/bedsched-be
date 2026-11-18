import crypto from 'node:crypto';
import pg from 'pg';
import { DIRECTIONS, buildDirectionalConsolidationPlan } from '../common/directionalConsolidation.js';
import { hashPassword } from '../common/userManagement.js';

const apply = process.argv.includes('--apply');
const simulate = process.argv.includes('--simulate');
const executeMigration = apply || simulate;
const accountArgument = process.argv.find((value) => value.startsWith('--accounts='));
const accountCount = Number(accountArgument?.split('=')[1] || 20);

if (!Number.isSafeInteger(accountCount) || accountCount < 0 || accountCount > 100) {
  throw new Error('--accounts must be an integer between 0 and 100');
}
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 15000,
  query_timeout: 30000,
});

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function inspectPlan() {
  const locations = await client.query(`
    SELECT
      l.id,
      l.name,
      l.capacity,
      (SELECT COUNT(*)::int FROM tents t WHERE t.location_id = l.id) AS section_count,
      (SELECT COUNT(*)::int FROM blocks b WHERE b.location_id = l.id) AS room_count,
      (SELECT COUNT(*)::int FROM allocations a WHERE a.location_id = l.id) AS allocation_count
    FROM locations l
    ORDER BY l.id
  `);
  const plan = buildDirectionalConsolidationPlan(locations.rows);
  const existingTargets = new Map(
    locations.rows
      .filter((row) => DIRECTIONS.includes(row.name))
      .map((row) => [row.name, row])
  );
  return {
    mode: apply ? 'apply' : (simulate ? 'simulate' : 'dry-run'),
    accountsRequested: accountCount,
    targets: DIRECTIONS.map((direction) => ({
      direction,
      existingLocationId: existingTargets.get(direction)?.id || null,
    })),
    sources: plan.map((row) => ({
      id: row.id,
      currentName: row.name,
      targetLocation: row.direction,
      targetSection: row.sectionName,
      rooms: row.room_count,
      allocations: row.allocation_count,
    })),
  };
}

async function ensureAccessSchema() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS user_location_access (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, location_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_location_access_location_id
      ON user_location_access(location_id);
    INSERT INTO user_location_access(user_id, location_id)
    SELECT id, location_id FROM users
    WHERE role = 'location_user' AND location_id IS NOT NULL
    ON CONFLICT (user_id, location_id) DO NOTHING;
  `);
}

async function createTargets() {
  const targets = new Map();
  for (const direction of DIRECTIONS) {
    const result = await client.query(`
      INSERT INTO locations(name, capacity)
      VALUES ($1, 0)
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id, name
    `, [direction]);
    targets.set(direction, Number(result.rows[0].id));
  }
  return targets;
}

async function prepareSourceLocation(source, targetLocationId) {
  const blocks = await client.query(`
    SELECT b.id, b.tent_id, b.block_index, b.name, b.size, t.tent_index
    FROM blocks b
    JOIN tents t ON t.id = b.tent_id
    WHERE b.location_id = $1
    ORDER BY t.tent_index, b.block_index, b.id
    FOR UPDATE OF b
  `, [source.id]);

  const allocationCheck = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM allocations a
    WHERE a.location_id = $1
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.id = a.block_id AND b.location_id = $1)
  `, [source.id]);
  if (allocationCheck.rows[0].count !== 0) {
    throw new Error(`Location ${source.name} contains allocations that are not attached to its rooms`);
  }

  const duplicate = await client.query(
    'SELECT id FROM tents WHERE location_id = $1 AND lower(name) = lower($2) LIMIT 1',
    [targetLocationId, source.sectionName]
  );
  if (duplicate.rowCount) {
    throw new Error(`Target section ${source.sectionName} already exists; refusing an ambiguous merge`);
  }

  const nextIndex = await client.query(
    'SELECT COALESCE(MAX(tent_index), 0)::int + 1 AS value FROM tents WHERE location_id = $1',
    [targetLocationId]
  );
  const tentIndex = Number(nextIndex.rows[0].value);
  const sectionSize = blocks.rows.reduce((sum, block) => sum + Number(block.size || 0), 0);
  const insertedTent = await client.query(`
    INSERT INTO tents(location_id, tent_index, name, size)
    VALUES ($1, $2, $3, $4)
    RETURNING id
  `, [targetLocationId, tentIndex, source.sectionName, sectionSize]);
  const tentId = Number(insertedTent.rows[0].id);

  if (blocks.rowCount > 0) {
    await client.query(`
      INSERT INTO directional_move_map(
        block_id, target_location_id, target_tent_id, target_tent_index, target_block_index
      )
      SELECT *
      FROM UNNEST($1::int[], $2::int[], $3::int[], $4::int[], $5::int[])
    `, [
      blocks.rows.map((block) => Number(block.id)),
      blocks.rows.map(() => targetLocationId),
      blocks.rows.map(() => tentId),
      blocks.rows.map(() => tentIndex),
      blocks.rows.map((_, index) => index + 1),
    ]);
  }

  return { roomsMoved: blocks.rowCount, allocationsMoved: Number(source.allocation_count || 0) };
}

async function finalizeSourceLocation(source, targetLocationId) {
  await client.query(`
    INSERT INTO user_location_access(user_id, location_id)
    SELECT DISTINCT user_id, $2::int
    FROM user_location_access
    WHERE location_id = $1
    ON CONFLICT (user_id, location_id) DO NOTHING
  `, [source.id, targetLocationId]);
  await client.query(`
    INSERT INTO user_location_access(user_id, location_id)
    SELECT id, $2::int FROM users WHERE location_id = $1
    ON CONFLICT (user_id, location_id) DO NOTHING
  `, [source.id, targetLocationId]);
  await client.query('UPDATE users SET location_id = $2 WHERE location_id = $1', [source.id, targetLocationId]);
  await client.query('DELETE FROM user_location_access WHERE location_id = $1', [source.id]);
  await client.query('DELETE FROM locations WHERE id = $1', [source.id]);
}

async function applyPreparedMoves() {
  await client.query(`
    UPDATE allocations a
    SET
      location_id = move.target_location_id,
      tent_id = move.target_tent_id,
      tent_index = move.target_tent_index,
      block_index = move.target_block_index,
      updated_at = NOW()
    FROM directional_move_map move
    WHERE a.block_id = move.block_id
  `);
  await client.query(`
    UPDATE blocks b
    SET
      location_id = move.target_location_id,
      tent_id = move.target_tent_id,
      tent_index = move.target_tent_index,
      block_index = move.target_block_index
    FROM directional_move_map move
    WHERE b.id = move.block_id
  `);
}

async function recomputeCapacities(targetIds) {
  await client.query(`
    UPDATE tents t
    SET size = room_totals.size
    FROM (
      SELECT tent_id, COALESCE(SUM(size), 0)::int AS size
      FROM blocks
      WHERE location_id = ANY($1::int[])
      GROUP BY tent_id
    ) room_totals
    WHERE t.id = room_totals.tent_id
  `, [targetIds]);
  await client.query(`
    UPDATE locations l
    SET capacity = section_totals.capacity
    FROM (
      SELECT location_id, COALESCE(SUM(size), 0)::int AS capacity
      FROM tents
      WHERE location_id = ANY($1::int[])
      GROUP BY location_id
    ) section_totals
    WHERE l.id = section_totals.location_id
  `, [targetIds]);
}

async function createDirectionalAccounts(targetIds) {
  const credentials = [];
  for (let index = 1; index <= accountCount; index += 1) {
    const username = `dir_${index}`;
    const existing = await client.query('SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
    let userId;
    let password = null;
    if (existing.rowCount) {
      userId = Number(existing.rows[0].id);
      await client.query(
        "UPDATE users SET role = 'location_user', location_id = $2 WHERE id = $1",
        [userId, targetIds[0]]
      );
    } else {
      password = crypto.randomBytes(12).toString('base64url');
      const passwordHash = await hashPassword(password);
      const inserted = await client.query(`
        INSERT INTO users(username, password, role, location_id)
        VALUES ($1, $2, 'location_user', $3)
        RETURNING id
      `, [username, passwordHash, targetIds[0]]);
      userId = Number(inserted.rows[0].id);
    }
    await client.query('DELETE FROM user_location_access WHERE user_id = $1', [userId]);
    await client.query(`
      INSERT INTO user_location_access(user_id, location_id)
      SELECT $1, UNNEST($2::int[])
    `, [userId, targetIds]);
    credentials.push({ username, password, status: password ? 'created' : 'existing-password-preserved' });
  }
  return credentials;
}

await client.connect();
try {
  if (!executeMigration) {
    await client.query('BEGIN READ ONLY');
    print(await inspectPlan());
    await client.query('ROLLBACK');
  } else {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('consolidate-directional-locations'))");
    await ensureAccessSchema();
    const planDetails = await inspectPlan();
    const plan = buildDirectionalConsolidationPlan((await client.query(`
      SELECT l.id, l.name, l.capacity,
        (SELECT COUNT(*)::int FROM allocations a WHERE a.location_id = l.id) AS allocation_count
      FROM locations l
    `)).rows);
    const sourceIds = plan.map((source) => Number(source.id));
    if (sourceIds.length > 0) {
      await client.query(
        'SELECT id FROM blocks WHERE location_id = ANY($1::int[]) ORDER BY id FOR UPDATE',
        [sourceIds]
      );
    }
    const before = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM locations) AS locations,
        (SELECT COUNT(*)::int FROM tents) AS sections,
        (SELECT COUNT(*)::int FROM blocks) AS rooms,
        (SELECT COUNT(*)::int FROM allocations) AS allocations,
        (SELECT COUNT(*)::int FROM allocations a JOIN blocks b ON b.id = a.block_id WHERE b.location_id = ANY($1::int[])) AS directional_allocations
    `, [sourceIds]);
    await client.query(`
      CREATE TEMP TABLE directional_move_map (
        block_id INTEGER PRIMARY KEY,
        target_location_id INTEGER NOT NULL,
        target_tent_id INTEGER NOT NULL,
        target_tent_index INTEGER NOT NULL,
        target_block_index INTEGER NOT NULL
      ) ON COMMIT DROP
    `);
    const targets = await createTargets();
    const moved = [];
    for (const source of plan) {
      moved.push({
        source: source.name,
        target: source.direction,
        section: source.sectionName,
        ...(await prepareSourceLocation(source, targets.get(source.direction))),
      });
    }
    await applyPreparedMoves();
    const movedAllocationCheck = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM allocations a
      JOIN directional_move_map move ON move.block_id = a.block_id
      WHERE a.location_id = move.target_location_id
        AND a.tent_id = move.target_tent_id
        AND a.tent_index = move.target_tent_index
        AND a.block_index = move.target_block_index
    `);
    for (const source of plan) {
      await finalizeSourceLocation(source, targets.get(source.direction));
    }
    const targetIds = DIRECTIONS.map((direction) => targets.get(direction));
    await recomputeCapacities(targetIds);
    const credentials = await createDirectionalAccounts(targetIds);
    const after = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM locations) AS locations,
        (SELECT COUNT(*)::int FROM tents) AS sections,
        (SELECT COUNT(*)::int FROM blocks) AS rooms,
        (SELECT COUNT(*)::int FROM allocations) AS allocations
    `);
    if (
      before.rows[0].rooms !== after.rows[0].rooms
      || Number(movedAllocationCheck.rows[0].count) !== Number(before.rows[0].directional_allocations)
    ) {
      throw new Error(
        `Room or directional allocation totals changed during consolidation; rolling back. Before=${JSON.stringify(before.rows[0])} After=${JSON.stringify(after.rows[0])} Moved=${JSON.stringify(movedAllocationCheck.rows[0])}`
      );
    }
    await client.query(simulate ? 'ROLLBACK' : 'COMMIT');
    print({
      mode: simulate ? 'simulated-and-rolled-back' : 'applied',
      preview: planDetails,
      moved,
      before: before.rows[0],
      after: after.rows[0],
      credentials,
    });
  }
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  throw error;
} finally {
  await client.end();
}
