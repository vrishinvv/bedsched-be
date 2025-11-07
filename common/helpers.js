import { execQuery } from './db.js';
import { generateViewUrl } from './s3.js';

// IST timezone functions - Get current date in IST as a DATE type
// Use NOW() to get current timestamp, convert to IST timezone, then cast to DATE
export const todaySQL = `(NOW() AT TIME ZONE 'Asia/Kolkata')::DATE`;
export const tomorrowSQL = `((NOW() AT TIME ZONE 'Asia/Kolkata')::DATE + INTERVAL '1 day')::DATE`;
export const nowIST = `NOW()`; // Keep as UTC for timestamp comparisons

// Helper function to get today's date in IST as YYYY-MM-DD string for JavaScript
export function getTodayIST() {
  const now = new Date();
  // Convert to IST by adding 5.5 hours
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffset);
  return istDate.toISOString().split('T')[0];
}


export async function getLocationsWithStats() {
  // Clean up expired reservations before fetching stats
  try {
    await execQuery(`
      UPDATE allocations
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE deleted_at IS NULL
        AND status = 'reserved'
        AND (
          (reserved_expires_at IS NOT NULL AND reserved_expires_at <= NOW())
          OR end_date < ${todaySQL}
        )
    `);
  } catch (cleanupErr) {
    console.error('[getLocationsWithStats] Cleanup error:', cleanupErr.message);
  }

  const q = `
    SELECT
      l.id,
      l.name,
      l.capacity,
      COALESCE(a.alloc_count, 0) AS allocated_count,
      COALESCE(a.free_tomorrow, 0) AS freeing_tomorrow,
      COALESCE(r.reserved_active, 0) AS reserved_count
    FROM locations l
    LEFT JOIN (
      SELECT
        location_id,
        COUNT(*) FILTER (WHERE end_date >= ${todaySQL} AND status = 'confirmed') AS alloc_count,
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
  // Clean up expired reservations before fetching location detail
  try {
    await execQuery(`
      UPDATE allocations
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE deleted_at IS NULL
        AND status = 'reserved'
        AND (
          (reserved_expires_at IS NOT NULL AND reserved_expires_at <= NOW())
          OR end_date < ${todaySQL}
        )
    `);
  } catch (cleanupErr) {
    console.error('[getLocationDetail] Cleanup error:', cleanupErr.message);
  }
  
  // Validate location exists
  const locRes = await execQuery(`SELECT id, name, capacity FROM locations WHERE id = $1`, [locationId]);
  if (locRes.rowCount === 0) return null;
  const loc = locRes.rows[0];

  // Get stats
  const statsQuery = `
    SELECT
      COALESCE(COUNT(*) FILTER (WHERE end_date >= ${todaySQL} AND status = 'confirmed'), 0) AS allocated,
      COALESCE(COUNT(*) FILTER (WHERE end_date = ${tomorrowSQL} AND (status = 'confirmed' OR (status = 'reserved' AND reserved_expires_at > ${nowIST}))), 0) AS freeing_tomorrow,
      COALESCE(COUNT(*) FILTER (WHERE status = 'reserved' AND reserved_expires_at > ${nowIST}), 0) AS reserved`;
  console.log('[DEBUG getLocationDetail] Stats query:', statsQuery);
  const statsRes = await execQuery(statsQuery + `
    FROM allocations
    WHERE location_id = $1 AND deleted_at IS NULL
  `, [locationId]);
  
  const stats = statsRes.rows[0] || { allocated: 0, freeing_tomorrow: 0, reserved: 0 };

  // Current and future allocations (from today onwards)
  // For confirmed: end_date >= TODAY
  // For reserved: reserved_expires_at > NOW (regardless of end_date)
  const activeRes = await execQuery(
    `
    SELECT 
      bed_number, 
      name, 
      phone, 
      aadhar_number,
      gender, 
      TO_CHAR(start_date, 'YYYY-MM-DD') as start_date_str,
      TO_CHAR(end_date, 'YYYY-MM-DD') as end_date_str,
      status, 
      reserved_expires_at
    FROM allocations
    WHERE location_id = $1
      AND deleted_at IS NULL
      AND (
        (status = 'confirmed' AND end_date >= ${todaySQL})
        OR (status = 'reserved' AND reserved_expires_at > ${nowIST})
      )
    `,
    [locationId]
  );

  // Build { [bedNumber]: allocation }
  const beds = {};
  for (const r of activeRes.rows) {
    beds[r.bed_number] = {
      name: r.name,
      phone: r.phone,
      aadharNumber: r.aadhar_number,
      gender: r.gender || 'Other',
      startDate: r.start_date_str, // Already formatted as YYYY-MM-DD string from TO_CHAR
      endDate: r.end_date_str,     // Already formatted as YYYY-MM-DD string from TO_CHAR
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
      t.name,
      t.size,
      COALESCE(a.allocated, 0) AS allocated,
      COALESCE(a.freeing_tomorrow, 0) AS freeing_tomorrow,
      COALESCE(r.reserved_active, 0) AS reserved
    FROM tents t
    LEFT JOIN (
      SELECT 
        tent_id,
        COUNT(*) FILTER (WHERE end_date >= ${todaySQL} AND status = 'confirmed') AS allocated,
        COUNT(*) FILTER (WHERE end_date = ${tomorrowSQL} AND (status = 'confirmed' OR (status = 'reserved' AND reserved_expires_at > ${nowIST}))) AS freeing_tomorrow
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
      name: t.name,
      size: Number(t.size),
      allocated: Number(t.allocated),
      freeingTomorrow: Number(t.freeing_tomorrow),
      reserved: Number(t.reserved || 0)
    }))
  };
}

export async function getTentBlocks(locationId, tentIndex) {
  // Clean up expired reservations before fetching tent blocks
  try {
    await execQuery(`
      UPDATE allocations
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE deleted_at IS NULL
        AND status = 'reserved'
        AND (
          (reserved_expires_at IS NOT NULL AND reserved_expires_at <= NOW())
          OR end_date < ${todaySQL}
        )
    `);
  } catch (cleanupErr) {
    console.error('[getTentBlocks] Cleanup error:', cleanupErr.message);
  }

  // Get location and tent info
  const tentRes = await execQuery(`
    SELECT t.id, t.tent_index, t.name, t.size, l.name as location_name
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
      b.name,
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
      name: tent.name,
      size: Number(tent.size)
    },
    blocks: blocksRes.rows.map(b => ({
      index: Number(b.block_index),
      name: b.name,
      size: Number(b.size),
      genderRestriction: b.gender_restriction,
      allocated: Number(b.allocated),
      freeingTomorrow: Number(b.freeing_tomorrow),
      reserved: Number(b.reserved || 0)
    }))
  };
}

export async function getBlockDetail(locationId, tentIndex, blockIndex) {
  // Clean up expired reservations before fetching block detail
  try {
    await execQuery(`
      UPDATE allocations
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE deleted_at IS NULL
        AND status = 'reserved'
        AND (
          (reserved_expires_at IS NOT NULL AND reserved_expires_at <= NOW())
          OR end_date < ${todaySQL}
        )
    `);
  } catch (cleanupErr) {
    console.error('[getBlockDetail] Cleanup error:', cleanupErr.message);
  }

  // Get block info
  const blockRes = await execQuery(`
    SELECT b.id, b.block_index, b.name, b.size, b.gender_restriction, t.tent_index, t.name as tent_name, l.name as location_name
    FROM blocks b
    JOIN tents t ON t.id = b.tent_id
    JOIN locations l ON l.id = t.location_id
    WHERE l.id = $1 AND t.tent_index = $2 AND b.block_index = $3
  `, [locationId, tentIndex, blockIndex]);
  
  if (blockRes.rowCount === 0) return null;
  const block = blockRes.rows[0];

  // Get bed allocations - current and future allocations only
  // Query dates as strings to avoid timezone conversion issues
  // For confirmed: end_date >= TODAY
  // For reserved: reserved_expires_at > NOW (regardless of end_date)
  const allocRes = await execQuery(`
    SELECT 
      bed_number, 
      name, 
      phone, 
      emergency_phone,
      gender, 
      TO_CHAR(start_date, 'YYYY-MM-DD') as start_date_str,
      TO_CHAR(end_date, 'YYYY-MM-DD') as end_date_str,
      person_photo_key,
      aadhaar_photo_key,
      status, 
      reserved_expires_at
    FROM allocations
    WHERE block_id = $1 
      AND deleted_at IS NULL
      AND (
        (status = 'confirmed' AND end_date >= ${todaySQL})
        OR (status = 'reserved' AND reserved_expires_at > ${nowIST})
      )
  `, [block.id]);

  // Build beds object
  const beds = {};
  for (const r of allocRes.rows) {
    const bedData = {
      name: r.name,
      phone: r.phone,
      emergencyPhone: r.emergency_phone,
      gender: r.gender || 'Other',
      startDate: r.start_date_str, // Already formatted as YYYY-MM-DD string from TO_CHAR
      endDate: r.end_date_str,     // Already formatted as YYYY-MM-DD string from TO_CHAR
      status: r.status,
      reservedExpiresAt: r.reserved_expires_at ? r.reserved_expires_at.toISOString() : null,
    };

    // Include photo keys and generate URLs if keys exist
    if (r.person_photo_key) {
      bedData.personPhotoKey = r.person_photo_key;
      bedData.personPhotoUrl = await generateViewUrl(r.person_photo_key);
    }
    if (r.aadhaar_photo_key) {
      bedData.aadhaarPhotoKey = r.aadhaar_photo_key;
      bedData.aadhaarPhotoUrl = await generateViewUrl(r.aadhaar_photo_key);
    }

    beds[r.bed_number] = bedData;
  }

  return {
    meta: {
      location: {
        id: String(locationId),
        name: block.location_name
      },
      tent: {
        index: Number(block.tent_index),
        name: block.tent_name
      },
      block: {
        index: Number(block.block_index),
        name: block.name,
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

// Combined validation function - does everything in ONE query
export async function validateAndGetBlockInfo(locationId, tentIndex, blockIndex, bedNumber, guestGender) {
  const result = await execQuery(`
    SELECT b.id as block_id, b.size, b.gender_restriction, t.id as tent_id
    FROM blocks b
    JOIN tents t ON t.id = b.tent_id
    WHERE t.location_id = $1 AND t.tent_index = $2 AND b.block_index = $3
  `, [locationId, tentIndex, blockIndex]);
  
  if (!result.rowCount) throw new Error('Block not found');
  const { block_id, size, gender_restriction, tent_id } = result.rows[0];
  
  // Validate bed number
  if (bedNumber < 1 || bedNumber > size) throw new Error('Bed out of range');
  
  // Validate gender restriction
  const normalizedGuestGender = guestGender?.toLowerCase();
  if (gender_restriction === 'male_only' && normalizedGuestGender !== 'male') {
    throw new Error('This tent is restricted to male guests only');
  }
  if (gender_restriction === 'female_only' && normalizedGuestGender !== 'female') {
    throw new Error('This tent is restricted to female guests only');
  }
  
  return { blockId: block_id, tentId: tent_id };
}