import { execQuery } from './db.js';

export const todaySQL = `CURRENT_DATE`;
export const tomorrowSQL = `CURRENT_DATE + INTERVAL '1 day'`;


export async function getLocationsWithStats() {
  const q = `
    SELECT
      l.id,
      l.name,
      l.capacity,
      COALESCE(a.alloc_today, 0) AS allocated_count,
      COALESCE(a.free_tomorrow, 0) AS freeing_tomorrow
    FROM locations l
    LEFT JOIN (
      SELECT
        location_id,
        COUNT(*) FILTER (WHERE end_date >= ${todaySQL}) AS alloc_today,
        COUNT(*) FILTER (WHERE end_date = (CURRENT_DATE + INTERVAL '1 day')::date) AS free_tomorrow
      FROM allocations
      WHERE deleted_at IS NULL
      GROUP BY location_id
    ) a ON a.location_id = l.id
    ORDER BY l.id ASC;
  `;
  const { rows } = await execQuery(q);
  return rows.map(r => ({
    id: String(r.id),
    name: r.name,
    capacity: Number(r.capacity),
    allocatedCount: Number(r.allocated_count),
    freeingTomorrow: Number(r.freeing_tomorrow),
  }));
}

export async function getLocationDetail(locationId) {
  // Validate location exists
  const locRes = await execQuery(`SELECT id, name, capacity FROM locations WHERE id = $1`, [locationId]);
  if (locRes.rowCount === 0) return null;
  const loc = locRes.rows[0];

  // Current and future allocations (from today onwards)
  const activeRes = await execQuery(
    `
    SELECT bed_number, name, phone, gender, start_date, end_date
    FROM allocations
    WHERE location_id = $1
      AND end_date >= ${todaySQL}
      AND deleted_at IS NULL
    `,
    [locationId]
  );

  // Build { [bedNumber]: allocation }
  const beds = {};
  for (const r of activeRes.rows) {
    // Format dates as YYYY-MM-DD without timezone conversion
    const formatDate = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    beds[r.bed_number] = {
      name: r.name,
      phone: r.phone,
      gender: r.gender || 'Other',
      startDate: formatDate(r.start_date),
      endDate: formatDate(r.end_date),
    };
  }

  return {
    id: String(loc.id),
    name: loc.name,
    capacity: Number(loc.capacity),
    beds,
  };
}

export async function validateBedWithinCapacity(locationId, bedNumber) {
  const { rows } = await execQuery(`SELECT capacity FROM locations WHERE id = $1`, [locationId]);
  if (!rows.length) throw new Error('Location not found');
  const cap = Number(rows[0].capacity);
  if (bedNumber < 1 || bedNumber > cap) throw new Error('Bed out of range');
}

// ...existing code...

export async function getLocationTents(locationId) {
  // Validate location exists
  const locRes = await execQuery(`SELECT id, name, capacity FROM locations WHERE id = $1`, [locationId]);
  if (locRes.rowCount === 0) return null;
  const location = locRes.rows[0];

  // Get tents with stats
  const tentsRes = await execQuery(`
    SELECT 
      t.id,
      t.tent_index,
      t.size,
      COALESCE(a.allocated, 0) AS allocated,
      COALESCE(a.freeing_tomorrow, 0) AS freeing_tomorrow
    FROM tents t
    LEFT JOIN (
      SELECT 
        tent_id,
        COUNT(*) FILTER (WHERE end_date >= ${todaySQL}) AS allocated,
        COUNT(*) FILTER (WHERE end_date = (CURRENT_DATE + INTERVAL '1 day')::date) AS freeing_tomorrow
      FROM allocations
      WHERE deleted_at IS NULL
      GROUP BY tent_id
    ) a ON a.tent_id = t.id
    WHERE t.location_id = $1
    ORDER BY t.tent_index ASC
  `, [locationId]);

  return {
    location: {
      id: String(location.id),
      name: location.name,
      capacity: Number(location.capacity)
    },
    tents: tentsRes.rows.map(t => ({
      index: Number(t.tent_index),
      size: Number(t.size),
      allocated: Number(t.allocated),
      freeingTomorrow: Number(t.freeing_tomorrow)
    }))
  };
}

export async function getTentBlocks(locationId, tentIndex) {
  // Get location and tent info
  const tentRes = await execQuery(`
    SELECT t.id, t.tent_index, t.size, l.name as location_name
    FROM tents t
    JOIN locations l ON l.id = t.location_id
    WHERE t.location_id = $1 AND t.tent_index = $2
  `, [locationId, tentIndex]);
  
  if (tentRes.rowCount === 0) return null;
  const tent = tentRes.rows[0];

  // Get blocks with stats
  const blocksRes = await execQuery(`
    SELECT 
      b.id,
      b.block_index,
      b.size,
      COALESCE(a.allocated, 0) AS allocated,
      COALESCE(a.freeing_tomorrow, 0) AS freeing_tomorrow
    FROM blocks b
    LEFT JOIN (
      SELECT 
        block_id,
        COUNT(*) FILTER (WHERE end_date >= ${todaySQL}) AS allocated,
        COUNT(*) FILTER (WHERE end_date = (CURRENT_DATE + INTERVAL '1 day')::date) AS freeing_tomorrow
      FROM allocations
      WHERE deleted_at IS NULL
      GROUP BY block_id
    ) a ON a.block_id = b.id
    WHERE b.tent_id = $1
    ORDER BY b.block_index ASC
  `, [tent.id]);

  return {
    location: {
      id: String(locationId),
      name: tent.location_name
    },
    tent: {
      index: Number(tent.tent_index),
      size: Number(tent.size)
    },
    blocks: blocksRes.rows.map(b => ({
      index: Number(b.block_index),
      size: Number(b.size),
      allocated: Number(b.allocated),
      freeingTomorrow: Number(b.freeing_tomorrow)
    }))
  };
}

export async function getBlockDetail(locationId, tentIndex, blockIndex) {
  // Get block info
  const blockRes = await execQuery(`
    SELECT b.id, b.block_index, b.size, t.tent_index, l.name as location_name
    FROM blocks b
    JOIN tents t ON t.id = b.tent_id
    JOIN locations l ON l.id = t.location_id
    WHERE l.id = $1 AND t.tent_index = $2 AND b.block_index = $3
  `, [locationId, tentIndex, blockIndex]);
  
  if (blockRes.rowCount === 0) return null;
  const block = blockRes.rows[0];

  // Get bed allocations
  const allocRes = await execQuery(`
    SELECT bed_number, name, phone, gender, start_date, end_date
    FROM allocations
    WHERE block_id = $1 AND end_date >= ${todaySQL} AND deleted_at IS NULL
  `, [block.id]);

  // Build beds object
  const beds = {};
  for (const r of allocRes.rows) {
    const formatDate = (date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    beds[r.bed_number] = {
      name: r.name,
      phone: r.phone,
      gender: r.gender || 'Other',
      startDate: formatDate(r.start_date),
      endDate: formatDate(r.end_date),
    };
  }

  return {
    meta: {
      location: {
        id: String(locationId),
        name: block.location_name
      },
      tent: {
        index: Number(block.tent_index)
      },
      block: {
        index: Number(block.block_index)
      }
    },
    blockSize: Number(block.size),
    beds
  };
}

export async function validateBedWithinBlock(locationId, tentIndex, blockIndex, bedNumber) {
  const blockRes = await execQuery(`
    SELECT b.id, b.size
    FROM blocks b
    JOIN tents t ON t.id = b.tent_id
    WHERE t.location_id = $1 AND t.tent_index = $2 AND b.block_index = $3
  `, [locationId, tentIndex, blockIndex]);
  
  if (!blockRes.rowCount) throw new Error('Block not found');
  const block = blockRes.rows[0];
  
  if (bedNumber < 1 || bedNumber > block.size) throw new Error('Bed out of range');
  return block.id;
}