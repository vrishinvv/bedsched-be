import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { config } from './common/configs.js';
import { execQuery } from './common/db.js';
import { getLocationsWithStats, getLocationDetail, validateBedWithinCapacity, todaySQL, tomorrowSQL } from './common/helpers.js';


const app = express();

// Configure CORS for production
const corsOptions = {
  origin: config.nodeEnv === 'production' 
    ? [config.frontendUrl] 
    : true, // Allow all origins in development
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());

// Only use morgan in development
if (config.nodeEnv === 'development') {
  app.use(morgan('dev'));
}

/* -------------------------------- Routes -------------------------------- */

// Health check route
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Seed quick convenience (optional)
app.post('/api/seed', async (req, res) => {
  try {
    // create 6 default tents if not exist
    await execQuery(`
      INSERT INTO locations(name, capacity)
      VALUES
        ('Tent A', 100),
        ('Tent B', 100),
        ('Tent C', 100),
        ('Tent D', 100),
        ('Tent E', 100),
        ('Tent F', 100)
      ON CONFLICT (name) DO NOTHING;
    `);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'seed_failed' });
  }
});

// GET /api/locations  -> [{ id, name, capacity, allocatedCount, freeingTomorrow }]
app.get('/api/locations', async (_req, res) => {
  try {
    const data = await getLocationsWithStats();
    
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'fetch_locations_failed' });
  }
});

// GET /api/locations/:id -> { id, name, capacity, beds: { "1": {...} } }
app.get('/api/locations/:id', async (req, res) => {
  try {
    const loc = await getLocationDetail(req.params.id);
    if (!loc) return res.status(404).json({ error: 'location_not_found' });
    console.log(loc);
    res.json(loc);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'fetch_location_failed' });
  }
});

// PATCH /api/locations/:id  body: { capacity }
app.patch('/api/locations/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { capacity } = req.body || {};
    if (!Number.isFinite(Number(capacity))) {
      return res.status(400).json({ error: 'invalid_capacity' });
    }
    // ensure not reducing
    const cur = await execQuery(`SELECT capacity FROM locations WHERE id = $1`, [id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'location_not_found' });
    if (Number(capacity) < Number(cur.rows[0].capacity)) {
      return res.status(400).json({ error: 'cannot_reduce_capacity' });
    }
    await execQuery(`UPDATE locations SET capacity = $1 WHERE id = $2`, [Number(capacity), id]);
    res.json({ ok: true, capacity: Number(capacity) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'update_capacity_failed' });
  }
});

// POST /api/locations/:id/beds/:bedNumber/allocate
// body: { name, phone, gender, startDate, endDate }
app.post('/api/locations/:id/beds/:bedNumber/allocate', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const bedNumber = Number(req.params.bedNumber);
    await validateBedWithinCapacity(id, bedNumber);

    const { name, phone, gender, startDate, endDate } = req.body || {};
    if (!name || !startDate || !endDate) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    // Insert allocation; exclusion constraint prevents overlaps
    const q = `
      INSERT INTO allocations(location_id, bed_number, name, phone, gender, start_date, end_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id
    `;
    await execQuery(q, [
      id,
      bedNumber,
      name,
      phone || null,
      gender || 'Other',
      startDate,
      endDate,
    ]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    // Exclusion constraint violation code is 23P01
    if (e.code === '23P01') {
      return res.status(409).json({ error: 'overlapping_allocation' });
    }
    res.status(500).json({ error: 'allocate_failed' });
  }
});

// PATCH /api/locations/:id/beds/:bedNumber
// body: partial { name, phone, gender, startDate, endDate }
// edits the CURRENT active allocation (today) for that bed
app.patch('/api/locations/:id/beds/:bedNumber', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const bedNumber = Number(req.params.bedNumber);
    await validateBedWithinCapacity(id, bedNumber);

    // find today's active allocation
    const findQ = `
      SELECT id FROM allocations
      WHERE location_id = $1
        AND bed_number  = $2
        AND ${todaySQL} BETWEEN start_date AND end_date
      LIMIT 1
    `;
    const active = await execQuery(findQ, [id, bedNumber]);
    if (!active.rowCount) return res.status(404).json({ error: 'no_active_allocation' });

    const allocId = active.rows[0].id;

    // Build dynamic update
    const fields = [];
    const values = [];
    let idx = 1;

    function push(col, val) {
      fields.push(`${col} = $${idx++}`);
      values.push(val);
    }

    const { name, phone, gender, startDate, endDate } = req.body || {};
    if (name !== undefined) push('name', name);
    if (phone !== undefined) push('phone', phone);
    if (gender !== undefined) push('gender', gender);
    if (startDate !== undefined) push('start_date', startDate);
    if (endDate !== undefined) push('end_date', endDate);
    push('updated_at', new Date());

    if (fields.length === 1) return res.json({ ok: true }); // only updated_at

    const q = `UPDATE allocations SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id`;
    await execQuery(q, [...values, allocId]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    if (e.code === '23P01') {
      return res.status(409).json({ error: 'overlapping_allocation' });
    }
    res.status(500).json({ error: 'edit_failed' });
  }
});

// DELETE /api/locations/:id/beds/:bedNumber (deallocate current active allocation)
app.delete('/api/locations/:id/beds/:bedNumber', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const bedNumber = Number(req.params.bedNumber);
    await validateBedWithinCapacity(id, bedNumber);

    const delQ = `
      DELETE FROM allocations
      WHERE id IN (
        SELECT id FROM allocations
        WHERE location_id = $1
          AND bed_number  = $2
          AND ${todaySQL} BETWEEN start_date AND end_date
        LIMIT 1
      )
    `;
    const r = await execQuery(delQ, [id, bedNumber]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'no_active_allocation' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'deallocate_failed' });
  }
});

/* --------------------------------- Start -------------------------------- */

app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
});
