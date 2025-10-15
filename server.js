import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { config } from './common/configs.js';
import { execQuery } from './common/db.js';
import {   
  getLocationsWithStats, 
  getLocationDetail, 
  getLocationTents,
  getTentBlocks,
  getBlockDetail,
  validateBedWithinCapacity,
  validateBedWithinBlock,
  todaySQL, 
  tomorrowSQL 
} from './common/helpers.js';


const app = express();

// Configure CORS for production
const corsOptions = {
  origin: ['http://localhost:3000', 'https://bedsched-fe.vercel.app'],
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
  const client = await execQuery('BEGIN'); // Start transaction
  
  try {
    // Clear existing data in reverse dependency order
    await execQuery('DELETE FROM allocations');
    await execQuery('DELETE FROM blocks');
    await execQuery('DELETE FROM tents');
    await execQuery('DELETE FROM locations');

    // Create locations with your specified names and capacities
    const locationData = [
      { name: 'West Gate North', capacity: 6000 },
      { name: 'West Gate South', capacity: 5500 },
      { name: 'Gas Tank', capacity: 2000 },
      { name: 'Bus Department', capacity: 1500 },
      { name: 'Electricity Board', capacity: 1500 },
      { name: 'Deer Park', capacity: 1500 }
    ];

    // Insert all locations in one query
    const locationValues = locationData.map((_, i) => 
      `($${i * 2 + 1}, $${i * 2 + 2})`
    ).join(', ');
    const locationParams = locationData.flatMap(loc => [loc.name, loc.capacity]);
    
    await execQuery(`
      INSERT INTO locations(name, capacity)
      VALUES ${locationValues};
    `, locationParams);

    // Get all locations
    const locations = await execQuery(`SELECT id, name, capacity FROM locations ORDER BY id`);
    
    // Prepare tent data
    const tentData = [];
    const blockData = [];
    
    for (const loc of locations.rows) {
      const capacity = Number(loc.capacity);
      const fullTents = Math.floor(capacity / 2000);
      const remainder = capacity % 2000;
      
      // Create full tents of 2000 seats each
      for (let tentIndex = 1; tentIndex <= fullTents; tentIndex++) {
        tentData.push([loc.id, tentIndex, 2000]);
        
        // Create blocks for this tent (500 beds per block)
        const fullBlocks = Math.floor(2000 / 500); // 4 blocks
        for (let blockIndex = 1; blockIndex <= fullBlocks; blockIndex++) {
          blockData.push([loc.id, null, tentIndex, blockIndex, 500]); // tent_id will be filled later
        }
      }
      
      // Create remainder tent if needed
      if (remainder > 0) {
        tentData.push([loc.id, fullTents + 1, remainder]);
        
        // Create blocks for remainder tent
        const fullBlocks = Math.floor(remainder / 500);
        const blockRemainder = remainder % 500;
        
        for (let blockIndex = 1; blockIndex <= fullBlocks; blockIndex++) {
          blockData.push([loc.id, null, fullTents + 1, blockIndex, 500]);
        }
        
        if (blockRemainder > 0) {
          blockData.push([loc.id, null, fullTents + 1, fullBlocks + 1, blockRemainder]);
        }
      }
    }

    // Insert all tents in one query
    if (tentData.length > 0) {
      const tentValues = tentData.map((_, i) => 
        `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`
      ).join(', ');
      const tentParams = tentData.flat();
      
      await execQuery(`
        INSERT INTO tents(location_id, tent_index, size)
        VALUES ${tentValues};
      `, tentParams);
    }

    // Get all tents to get their IDs
    const tents = await execQuery(`
      SELECT id, location_id, tent_index, size 
      FROM tents 
      ORDER BY location_id, tent_index
    `);
    
    // Create a map for quick tent lookup
    const tentMap = {};
    tents.rows.forEach(tent => {
      const key = `${tent.location_id}-${tent.tent_index}`;
      tentMap[key] = tent.id;
    });

    // Update block data with tent IDs
    const finalBlockData = blockData.map(block => {
      const [locationId, _, tentIndex, blockIndex, size] = block;
      const tentId = tentMap[`${locationId}-${tentIndex}`];
      return [locationId, tentId, tentIndex, blockIndex, size];
    });

    // Insert all blocks in one query
    if (finalBlockData.length > 0) {
      const blockValues = finalBlockData.map((_, i) => 
        `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`
      ).join(', ');
      const blockParams = finalBlockData.flat();
      
      await execQuery(`
        INSERT INTO blocks(location_id, tent_id, tent_index, block_index, size)
        VALUES ${blockValues};
      `, blockParams);
    }

    // Get first 15 blocks for sample allocations
    const blocks = await execQuery(`
      SELECT b.id as block_id, b.location_id, b.tent_id, t.tent_index, b.block_index, b.size
      FROM blocks b
      JOIN tents t ON t.id = b.tent_id
      ORDER BY b.location_id, t.tent_index, b.block_index
      LIMIT 15
    `);

    // Prepare allocation data
    const allocationData = [];
    const names = ['Rajesh Kumar', 'Priya Sharma', 'Amit Patel', 'Sunita Devi', 'Vikash Singh', 'Meera Gupta'];
    const genders = ['Male', 'Female', 'Other'];

    for (const block of blocks.rows) {
      const bedsToAllocate = Math.floor(block.size * 0.1); // 10% occupancy
      
      for (let bedNum = 1; bedNum <= bedsToAllocate; bedNum++) {
        const name = names[Math.floor(Math.random() * names.length)];
        const gender = genders[Math.floor(Math.random() * genders.length)];
        
        // Random allocation duration (1-5 days starting today)
        const startDate = new Date();
        const endDate = new Date();
        endDate.setDate(startDate.getDate() + Math.floor(Math.random() * 5) + 1);
        
        allocationData.push([
          block.location_id,
          block.tent_id,
          block.block_id,
          block.tent_index,
          block.block_index,
          bedNum,
          name,
          `+91-${Math.floor(Math.random() * 9000000000) + 1000000000}`,
          gender,
          startDate.toISOString().split('T')[0],
          endDate.toISOString().split('T')[0]
        ]);
      }
    }

    // Insert all allocations in one query
    if (allocationData.length > 0) {
      const allocationValues = allocationData.map((_, i) => 
        `($${i * 11 + 1}, $${i * 11 + 2}, $${i * 11 + 3}, $${i * 11 + 4}, $${i * 11 + 5}, $${i * 11 + 6}, $${i * 11 + 7}, $${i * 11 + 8}, $${i * 11 + 9}, $${i * 11 + 10}, $${i * 11 + 11})`
      ).join(', ');
      const allocationParams = allocationData.flat();
      
      await execQuery(`
        INSERT INTO allocations(location_id, tent_id, block_id, tent_index, block_index, bed_number, name, phone, gender, start_date, end_date)
        VALUES ${allocationValues};
      `, allocationParams);
    }

    // Calculate and return summary
    const summary = await execQuery(`
      SELECT 
        l.name,
        l.capacity,
        COUNT(DISTINCT t.id) as tent_count,
        COUNT(DISTINCT b.id) as block_count,
        SUM(b.size) as total_beds
      FROM locations l
      LEFT JOIN tents t ON t.location_id = l.id
      LEFT JOIN blocks b ON b.tent_id = t.id
      GROUP BY l.id, l.name, l.capacity
      ORDER BY l.id
    `);

    await execQuery('COMMIT'); // Commit transaction

    res.json({ 
      ok: true, 
      message: 'Successfully seeded database with hierarchical structure',
      summary: summary.rows.map(s => ({
        location: s.name,
        capacity: Number(s.capacity),
        tents: Number(s.tent_count),
        blocks: Number(s.block_count),
        totalBeds: Number(s.total_beds)
      }))
    });
  } catch (e) {
    await execQuery('ROLLBACK'); // Rollback on error
    console.error(e);
    res.status(500).json({ error: 'seed_failed', details: e.message });
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


// ...existing routes...

// GET /api/locations/:id/tents
app.get('/api/locations/:id/tents', async (req, res) => {
  try {
    const data = await getLocationTents(req.params.id);
    if (!data) return res.status(404).json({ error: 'location_not_found' });
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'fetch_tents_failed' });
  }
});

// GET /api/locations/:id/tents/:tent/blocks
app.get('/api/locations/:id/tents/:tent/blocks', async (req, res) => {
  try {
    const data = await getTentBlocks(req.params.id, Number(req.params.tent));
    if (!data) return res.status(404).json({ error: 'tent_not_found' });
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'fetch_blocks_failed' });
  }
});

// GET /api/locations/:id/tents/:tent/blocks/:block
app.get('/api/locations/:id/tents/:tent/blocks/:block', async (req, res) => {
  try {
    const data = await getBlockDetail(
      req.params.id, 
      Number(req.params.tent), 
      Number(req.params.block)
    );
    if (!data) return res.status(404).json({ error: 'block_not_found' });
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'fetch_block_detail_failed' });
  }
});

// POST /api/locations/:id/tents/:tent/blocks/:block/beds/:bedNumber/allocate
app.post('/api/locations/:id/tents/:tent/blocks/:block/beds/:bedNumber/allocate', async (req, res) => {
  try {
    const locationId = Number(req.params.id);
    const tentIndex = Number(req.params.tent);
    const blockIndex = Number(req.params.block);
    const bedNumber = Number(req.params.bedNumber);
    
    const blockId = await validateBedWithinBlock(locationId, tentIndex, blockIndex, bedNumber);

    const { name, phone, gender, startDate, endDate } = req.body || {};
    if (!name || !startDate || !endDate) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    // Get tent_id for the allocation
    const tentRes = await execQuery(`
      SELECT id FROM tents WHERE location_id = $1 AND tent_index = $2
    `, [locationId, tentIndex]);
    const tentId = tentRes.rows[0].id;

    const q = `
      INSERT INTO allocations(location_id, tent_id, block_id, tent_index, block_index, bed_number, name, phone, gender, start_date, end_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id
    `;
    await execQuery(q, [
      locationId,
      tentId,
      blockId,
      tentIndex,
      blockIndex,
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
    if (e.code === '23P01') {
      return res.status(409).json({ error: 'overlapping_allocation' });
    }
    res.status(500).json({ error: 'allocate_failed' });
  }
});

// PATCH /api/locations/:id/tents/:tent/blocks/:block/beds/:bedNumber
app.patch('/api/locations/:id/tents/:tent/blocks/:block/beds/:bedNumber', async (req, res) => {
  try {
    const locationId = Number(req.params.id);
    const tentIndex = Number(req.params.tent);
    const blockIndex = Number(req.params.block);
    const bedNumber = Number(req.params.bedNumber);
    
    const blockId = await validateBedWithinBlock(locationId, tentIndex, blockIndex, bedNumber);

    // Find today's active allocation
    const findQ = `
      SELECT id FROM allocations
      WHERE block_id = $1
        AND bed_number = $2
        AND ${todaySQL} BETWEEN start_date AND end_date
      LIMIT 1
    `;
    const active = await execQuery(findQ, [blockId, bedNumber]);
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

    if (fields.length === 1) return res.json({ ok: true });

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

// DELETE /api/locations/:id/tents/:tent/blocks/:block/beds/:bedNumber
app.delete('/api/locations/:id/tents/:tent/blocks/:block/beds/:bedNumber', async (req, res) => {
  try {
    const locationId = Number(req.params.id);
    const tentIndex = Number(req.params.tent);
    const blockIndex = Number(req.params.block);
    const bedNumber = Number(req.params.bedNumber);
    
    const blockId = await validateBedWithinBlock(locationId, tentIndex, blockIndex, bedNumber);

    const delQ = `
      DELETE FROM allocations
      WHERE id IN (
        SELECT id FROM allocations
        WHERE block_id = $1
          AND bed_number = $2
          AND ${todaySQL} BETWEEN start_date AND end_date
        LIMIT 1
      )
    `;
    const r = await execQuery(delQ, [blockId, bedNumber]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'no_active_allocation' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'deallocate_failed' });
  }
});

