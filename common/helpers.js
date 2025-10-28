import { execQuery } from './db.js';

// IST timezone functions - PostgreSQL uses UTC by default, we need IST (UTC+5:30)
export const todaySQL = `(CURRENT_DATE AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date`;
export const tomorrowSQL = `((CURRENT_DATE AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') + INTERVAL '1 day')::date`;
export const nowIST = `(NOW() AT TIME ZONE 'Asia/Kolkata')`;

// Helper function to get today's date in IST as YYYY-MM-DD string for JavaScript
export function getTodayIST() {
  const now = new Date();
  // Convert to IST by adding 5.5 hours
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffset);
  return istDate.toISOString().split('T')[0];
}


export async function getLocationsWithStats() {
  const q = `
    SELECT
      l.id,
      l.name,
      l.capacity,
      COALESCE(a.alloc_today, 0) AS allocated_count,
      COALESCE(a.free_tomorrow, 0) AS freeing_tomorrow,
      COALESCE(r.reserved_active, 0) AS reserved_count
    FROM locations l
    LEFT JOIN (
      SELECT
        location_id,
        COUNT(*) FILTER (WHERE end_date >= ${todaySQL} AND status = 'confirmed') AS alloc_today,
        COUNT(*) FILTER (WHERE end_date = ${tomorrowSQL} AND (status = 'confirmed' OR (status = 'reserved' AND reserved_expires_at > ${nowIST}))) AS free_tomorrow
      FROM allocations
      WHERE deleted_at IS NULL
      GROUP BY location_id
    ) a ON a.location_id = l.id
    LEFT JOIN (
      SELECT location_id, COUNT(*) AS reserved_active
      FROM allocations
      WHERE deleted_at IS NULL AND status = 'reserved' AND reserved_expires_at > ${nowIST}
      GROUP BY location_id
    ) r ON r.location_id = l.id
    ORDER BY l.id ASC;
  `;
  const { rows } = await execQuery(q);
  return rows.map(r => ({
    id: String(r.id),
    name: r.name,
    capacity: Number(r.capacity),
    allocatedCount: Number(r.allocated_count),
    freeingTomorrow: Number(r.freeing_tomorrow),
    reservedCount: Number(r.reserved_count || 0),
  }));
}

export async function getLocationDetail(locationId) {
  // Validate location exists
  const locRes = await execQuery(`SELECT id, name, capacity FROM locations WHERE id = $1`, [locationId]);
  if (locRes.rowCount === 0) return null;
  const loc = locRes.rows[0];

  // Get stats
  const statsRes = await execQuery(`
    SELECT
      COALESCE(COUNT(*) FILTER (WHERE end_date >= ${todaySQL} AND status = 'confirmed'), 0) AS allocated,
      COALESCE(COUNT(*) FILTER (WHERE end_date = ${tomorrowSQL} AND (status = 'confirmed' OR (status = 'reserved' AND reserved_expires_at > ${nowIST}))), 0) AS freeing_tomorrow,
      COALESCE(COUNT(*) FILTER (WHERE status = 'reserved' AND reserved_expires_at > ${nowIST}), 0) AS reserved
    FROM allocations
    WHERE location_id = $1 AND deleted_at IS NULL
  `, [locationId]);
  
  const stats = statsRes.rows[0] || { allocated: 0, freeing_tomorrow: 0, reserved: 0 };

  // Current and future allocations (from today onwards)
  const activeRes = await execQuery(
    `
    SELECT bed_number, name, phone, gender, start_date, end_date, status, reserved_expires_at
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
      status: r.status,
      reservedExpiresAt: r.reserved_expires_at ? r.reserved_expires_at.toISOString() : null,
    };
  }

  return {
    id: String(loc.id),
    name: loc.name,
    capacity: Number(loc.capacity),
    allocated: Number(stats.allocated),
    freeingTomorrow: Number(stats.freeing_tomorrow),
    reserved: Number(stats.reserved),
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
      COALESCE(a.freeing_tomorrow, 0) AS freeing_tomorrow,
      COALESCE(r.reserved_active, 0) AS reserved
    FROM tents t
    LEFT JOIN (
      SELECT 
        tent_id,
        COUNT(*) FILTER (WHERE end_date >= ${todaySQL} AND status = 'confirmed') AS allocated,
        COUNT(*) FILTER (WHERE end_date = (CURRENT_DATE + INTERVAL '1 day')::date AND (status = 'confirmed' OR (status = 'reserved' AND reserved_expires_at > ${nowIST}))) AS freeing_tomorrow
      FROM allocations
      WHERE deleted_at IS NULL
      GROUP BY tent_id
    ) a ON a.tent_id = t.id
    LEFT JOIN (
      SELECT tent_id, COUNT(*) AS reserved_active
      FROM allocations
      WHERE deleted_at IS NULL AND status = 'reserved' AND reserved_expires_at > ${nowIST}
      GROUP BY tent_id
    ) r ON r.tent_id = t.id
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
      freeingTomorrow: Number(t.freeing_tomorrow),
      reserved: Number(t.reserved || 0)
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
      b.gender_restriction,
      COALESCE(a.allocated, 0) AS allocated,
      COALESCE(a.freeing_tomorrow, 0) AS freeing_tomorrow,
      COALESCE(r.reserved_active, 0) AS reserved
    FROM blocks b
    LEFT JOIN (
      SELECT 
        block_id,
        COUNT(*) FILTER (WHERE end_date >= ${todaySQL} AND status = 'confirmed') AS allocated,
        COUNT(*) FILTER (WHERE end_date = ${tomorrowSQL} AND (status = 'confirmed' OR (status = 'reserved' AND reserved_expires_at > ${nowIST}))) AS freeing_tomorrow
      FROM allocations
      WHERE deleted_at IS NULL
      GROUP BY block_id
    ) a ON a.block_id = b.id
    LEFT JOIN (
      SELECT block_id, COUNT(*) AS reserved_active
      FROM allocations
      WHERE deleted_at IS NULL AND status = 'reserved' AND reserved_expires_at > ${nowIST}
      GROUP BY block_id
    ) r ON r.block_id = b.id
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
      genderRestriction: b.gender_restriction,
      allocated: Number(b.allocated),
      freeingTomorrow: Number(b.freeing_tomorrow),
      reserved: Number(b.reserved || 0)
    }))
  };
}

export async function getBlockDetail(locationId, tentIndex, blockIndex) {
  // Get block info
  const blockRes = await execQuery(`
    SELECT b.id, b.block_index, b.size, b.gender_restriction, t.tent_index, l.name as location_name
    FROM blocks b
    JOIN tents t ON t.id = b.tent_id
    JOIN locations l ON l.id = t.location_id
    WHERE l.id = $1 AND t.tent_index = $2 AND b.block_index = $3
  `, [locationId, tentIndex, blockIndex]);
  
  if (blockRes.rowCount === 0) return null;
  const block = blockRes.rows[0];

  // Get bed allocations
  const allocRes = await execQuery(`
    SELECT bed_number, name, phone, gender, start_date, end_date, status, reserved_expires_at
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
      status: r.status,
      reservedExpiresAt: r.reserved_expires_at ? r.reserved_expires_at.toISOString() : null,
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
        index: Number(block.block_index),
        genderRestriction: block.gender_restriction
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

export async function validateGenderRestriction(locationId, tentIndex, blockIndex, guestGender) {
  const blockRes = await execQuery(`
    SELECT b.gender_restriction
    FROM blocks b
    JOIN tents t ON t.id = b.tent_id
    WHERE t.location_id = $1 AND t.tent_index = $2 AND b.block_index = $3
  `, [locationId, tentIndex, blockIndex]);
  
  if (!blockRes.rowCount) throw new Error('Block not found');
  const { gender_restriction } = blockRes.rows[0];
  
  // Normalize gender values for comparison
  const normalizedGuestGender = guestGender?.toLowerCase();
  
  if (gender_restriction === 'male_only' && normalizedGuestGender !== 'male') {
    throw new Error('This tent is restricted to male guests only');
  }
  
  if (gender_restriction === 'female_only' && normalizedGuestGender !== 'female') {
    throw new Error('This tent is restricted to female guests only');
  }
  
  // 'both' restriction allows any gender
  return true;
}