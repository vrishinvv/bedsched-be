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
