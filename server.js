import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
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
  validateGenderRestriction,
  getTodayIST,
  todaySQL, 
  tomorrowSQL,
  nowIST
} from './common/helpers.js';


const app = express();

// Configure CORS for production
const corsOptions = {
  origin: ['http://localhost:3000', 'https://bedsched-fe.vercel.app'],
  credentials: true,
  optionsSuccessStatus: 200,
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

// Only use morgan in development
if (config.nodeEnv === 'development') {
  app.use(morgan('dev'));
}

/* ------------------------------ Auth Guard ------------------------------ */

// Helpers to read auth from header or cookies
function getUserFromRequest(req) {
  // Prefer Bearer token from Authorization header if present
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim();
    try {
      const payload = jwt.verify(token, config.jwtSecret);
      if (payload && payload.username && payload.role) {
        return { username: payload.username, role: payload.role };
      }
    } catch (e) {
      // invalid token -> fall back to cookies
    }
  }
  const user = req.cookies?.bs_user;
  const role = req.cookies?.bs_role;
  if (user && role) return { username: user, role };
  return null;
}

// Global guard for API routes, excluding auth/health/seed
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  if (req.path.startsWith('/api/auth')) return next();
  if (req.path === '/api/health') return next();
  if (req.path === '/api/seed') return next();

  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  // Dashboard role restriction: allow GET /api/locations and smart-reserve; admin can access all
  if (user.role === 'dashboard') {
    const isLocationsList = req.method === 'GET' && req.path === '/api/locations';
    const isSmartReserve = req.method === 'POST' && req.path === '/api/allocations/smart-reserve';
    if (!isLocationsList && !isSmartReserve) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }
  // else admin: allow all
  return next();
});

/* -------------------------------- Routes -------------------------------- */

// Auth routes
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'missing_credentials' });

    const r = await execQuery(
      `SELECT username, password, role FROM users WHERE username = $1 LIMIT 1`,
      [username]
    );
    if (!r.rowCount) return res.status(401).json({ error: 'invalid_credentials' });
    const u = r.rows[0];
    if (u.password !== password) return res.status(401).json({ error: 'invalid_credentials' });

    // Set cookies for auth - use 'none' for cross-site with secure, or 'lax' for same-site
    const cookieOptions = {
      httpOnly: true,
      sameSite: config.nodeEnv === 'production' ? 'none' : 'lax', // 'none' allows cross-site cookies
      secure: config.nodeEnv === 'production', // required when sameSite=none
      path: '/',
    };
    res.cookie('bs_user', u.username, cookieOptions);
    res.cookie('bs_role', u.role, cookieOptions);

    // Also return a signed JWT for token-based auth on platforms where cookies are unreliable
    const token = jwt.sign({ username: u.username, role: u.role }, config.jwtSecret, { expiresIn: '7d' });
    res.json({ ok: true, user: { username: u.username, role: u.role }, token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'login_failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('bs_user', { path: '/' });
  res.clearCookie('bs_role', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user });
});

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

    // Optional: set some block-level gender restrictions for demo data
    // Pattern: block_index 1 => male_only, 2 => female_only, others => both
    await execQuery(`
      UPDATE blocks b
      SET gender_restriction = CASE 
        WHEN (b.block_index % 3) = 1 THEN 'male_only'
        WHEN (b.block_index % 3) = 2 THEN 'female_only'
        ELSE 'both'
      END
    `);

    // Get first 15 blocks for sample allocations (include restriction)
    const blocks = await execQuery(`
      SELECT b.id as block_id, b.location_id, b.tent_id, t.tent_index, b.block_index, b.size, b.gender_restriction
      FROM blocks b
      JOIN tents t ON t.id = b.tent_id
      ORDER BY b.location_id, t.tent_index, b.block_index
      LIMIT 15
    `);

    // Prepare allocation data
    const allocationData = [];
    const names = ['Rajesh Kumar', 'Priya Sharma', 'Amit Patel', 'Sunita Devi', 'Vikash Singh', 'Meera Gupta'];
    const genders = ['Male', 'Female', 'Other']; // Use full words that match the check constraint

    for (const block of blocks.rows) {
      const bedsToAllocate = Math.floor(block.size * 0.1); // 10% occupancy
      
      for (let bedNum = 1; bedNum <= bedsToAllocate; bedNum++) {
        const name = names[Math.floor(Math.random() * names.length)];
        // Respect block-level gender restriction when seeding
        let gender;
        if (block.gender_restriction === 'male_only') {
          gender = 'Male';
        } else if (block.gender_restriction === 'female_only') {
          gender = 'Female';
        } else {
          gender = genders[Math.floor(Math.random() * genders.length)];
        }
        
        // Random allocation duration (1-5 days starting today in IST)
        const now = new Date();
        const istOffset = 5.5 * 60 * 60 * 1000;
        const istNow = new Date(now.getTime() + istOffset);
        const startDate = istNow.toISOString().split('T')[0];
        
        const endDateObj = new Date(istNow);
        endDateObj.setDate(istNow.getDate() + Math.floor(Math.random() * 5) + 1);
        const endDate = endDateObj.toISOString().split('T')[0];
        
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
          startDate,
          endDate
        ]);
      }
    }

    // Insert all allocations in one query (confirmed by default)
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

    // Optional: seed a few reserved rows for demo visibility (expire in ~7 hours)
    const demoReserved = await execQuery(`
      SELECT b.location_id, b.tent_id, b.id as block_id, t.tent_index, b.block_index, b.size
      FROM blocks b JOIN tents t ON t.id = b.tent_id
      ORDER BY b.location_id, t.tent_index, b.block_index
      LIMIT 3
    `);
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);
    const todayIST = istNow.toISOString().split('T')[0];
    const sevenHours = new Date(now.getTime() + (config.reservationTTLHours * 60 * 60 * 1000));
    for (const br of demoReserved.rows) {
      // find first available bed in this block
      const occ = await execQuery(`
        SELECT bed_number FROM allocations WHERE block_id = $1 AND deleted_at IS NULL AND end_date >= ${todaySQL}
      `, [br.block_id]);
      const occupied = new Set(occ.rows.map(r => Number(r.bed_number)));
      let bed = 1;
      while (bed <= br.size && occupied.has(bed)) bed++;
      if (bed <= br.size) {
        await execQuery(`
          INSERT INTO allocations(
            location_id, tent_id, block_id, tent_index, block_index, bed_number,
            name, phone, gender, start_date, end_date,
            status, batch_id, contact_name, is_family, reserved_expires_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'reserved',$12,$13,$14,$15)
        `, [
          br.location_id, br.tent_id, br.block_id, br.tent_index, br.block_index, bed,
          'Reserved', `+91-${Math.floor(Math.random() * 9000000000) + 1000000000}`, 'Other',
          todayIST, todayIST,
          `seed_${Date.now()}`, 'Seed Demo', false, sevenHours
        ]);
      }
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

    // Validate and normalize gender
    const validGenders = ['Male', 'Female', 'Other'];
    const normalizedGender = gender && gender.trim() && validGenders.includes(gender.trim()) 
      ? gender.trim() 
      : 'Other';

    // Cleanup: soft-delete expired reservations that overlap this range for this bed
    try {
      await execQuery(`
        UPDATE allocations
        SET deleted_at = NOW(), updated_at = NOW()
        WHERE location_id = $1
          AND bed_number = $2
          AND status = 'reserved'
          AND reserved_expires_at IS NOT NULL
          AND reserved_expires_at <= ${nowIST}
          AND deleted_at IS NULL
          AND daterange(start_date, end_date, '[]') && daterange($3::date, $4::date, '[]')
      `, [id, bedNumber, startDate, endDate]);
    } catch {}

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
      normalizedGender,
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
// soft deletes current allocation and creates new one (preserves history)
app.patch('/api/locations/:id/beds/:bedNumber', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const bedNumber = Number(req.params.bedNumber);
    if (!Number.isFinite(bedNumber)) return res.status(400).json({ error: 'invalid_bed_number' });
    await validateBedWithinCapacity(id, bedNumber);

    // find current active allocation
    const findQ = `
      SELECT id, name, phone, gender, start_date, end_date FROM allocations
      WHERE location_id = $1
        AND bed_number = $2
        AND deleted_at IS NULL
        AND end_date >= (CURRENT_DATE AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const active = await execQuery(findQ, [id, bedNumber]);
    if (!active.rowCount) return res.status(404).json({ error: 'no_active_allocation' });

    const current = active.rows[0];
    const { name, phone, gender, startDate, endDate } = req.body || {};

    // Use current values as defaults for missing fields
    const newName = name !== undefined ? name : current.name;
    const newPhone = phone !== undefined ? phone : current.phone;
    const newGender = gender !== undefined ? (
      gender && gender.trim() && ['Male', 'Female', 'Other'].includes(gender.trim()) 
        ? gender.trim() 
        : 'Other'
    ) : current.gender;
    const newStartDate = startDate !== undefined ? startDate : current.start_date.toISOString().split('T')[0];
    const newEndDate = endDate !== undefined ? endDate : current.end_date.toISOString().split('T')[0];

    // Begin transaction
    await execQuery('BEGIN');

    try {
      // Soft delete current allocation
      await execQuery(
        `UPDATE allocations SET deleted_at = NOW() WHERE id = $1`,
        [current.id]
      );

      // Create new allocation with updated values
      const insertQ = `
        INSERT INTO allocations(location_id, bed_number, name, phone, gender, start_date, end_date)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
      `;
      await execQuery(insertQ, [
        id,
        bedNumber,
        newName,
        newPhone,
        newGender,
        newStartDate,
        newEndDate
      ]);

      await execQuery('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await execQuery('ROLLBACK');
      throw e;
    }
  } catch (e) {
    console.error(e);
    if (e.code === '23P01') {
      return res.status(409).json({ error: 'overlapping_allocation' });
    }
    res.status(500).json({ error: 'edit_failed' });
  }
});

// DELETE /api/locations/:id/beds/:bedNumber (soft delete current active allocation)
app.delete('/api/locations/:id/beds/:bedNumber', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const bedNumber = Number(req.params.bedNumber);
    await validateBedWithinCapacity(id, bedNumber);

    const delQ = `
      UPDATE allocations 
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE id IN (
        SELECT id FROM allocations
        WHERE location_id = $1
          AND bed_number = $2
          AND deleted_at IS NULL
          AND end_date >= (CURRENT_DATE AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
        ORDER BY created_at DESC
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

// PATCH /api/locations/:id/tents/:tent/blocks/:block
// body: { genderRestriction }
app.patch('/api/locations/:id/tents/:tent/blocks/:block', async (req, res) => {
  try {
    const locationId = Number(req.params.id);
    const tentIndex = Number(req.params.tent);
    const blockIndex = Number(req.params.block);
    const { genderRestriction } = req.body || {};

    if (!genderRestriction || !['male_only', 'female_only', 'both'].includes(genderRestriction)) {
      return res.status(400).json({ error: 'invalid_gender_restriction' });
    }

    // Verify block exists and get current restriction
    const blockRes = await execQuery(`
      SELECT b.id, b.gender_restriction
      FROM blocks b
      JOIN tents t ON t.id = b.tent_id
      WHERE t.location_id = $1 AND t.tent_index = $2 AND b.block_index = $3
    `, [locationId, tentIndex, blockIndex]);

    if (!blockRes.rowCount) {
      return res.status(404).json({ error: 'block_not_found' });
    }

    const blockId = blockRes.rows[0].id;
    const currentRestriction = blockRes.rows[0].gender_restriction;

    // If restriction is changing, validate existing allocations in this block
    if (currentRestriction !== genderRestriction) {
      const now = new Date();
      const istOffset = 5.5 * 60 * 60 * 1000;
      const istDate = new Date(now.getTime() + istOffset);
      const today = istDate.toISOString().split('T')[0];
      const existingAllocations = await execQuery(`
        SELECT DISTINCT gender, COUNT(*) as count
        FROM allocations
        WHERE block_id = $1 AND end_date >= $2 AND deleted_at IS NULL
        GROUP BY gender
      `, [blockId, today]);

      if (existingAllocations.rowCount > 0) {
        const genders = existingAllocations.rows.map(row => ({
          gender: row.gender,
          count: Number(row.count)
        }));

        let violationMessage = null;
        if (genderRestriction === 'male_only') {
          const nonMaleBookings = genders.filter(g => g.gender !== 'Male');
          if (nonMaleBookings.length > 0) {
            const totalNonMale = nonMaleBookings.reduce((sum, g) => sum + g.count, 0);
            violationMessage = `Cannot change to male-only: ${totalNonMale} active booking(s) for non-male guests exist. ` +
              `Genders: ${nonMaleBookings.map(g => `${g.gender} (${g.count})`).join(', ')}.`;
          }
        } else if (genderRestriction === 'female_only') {
          const nonFemaleBookings = genders.filter(g => g.gender !== 'Female');
          if (nonFemaleBookings.length > 0) {
            const totalNonFemale = nonFemaleBookings.reduce((sum, g) => sum + g.count, 0);
            violationMessage = `Cannot change to female-only: ${totalNonFemale} active booking(s) for non-female guests exist. ` +
              `Genders: ${nonFemaleBookings.map(g => `${g.gender} (${g.count})`).join(', ')}.`;
          }
        }

        if (violationMessage) {
          return res.status(409).json({ 
            error: 'existing_bookings_conflict', 
            message: violationMessage,
            existingGenders: genders
          });
        }
      }
    }

    await execQuery(`
      UPDATE blocks SET gender_restriction = $1 
      WHERE id = $2
    `, [genderRestriction, blockId]);

    res.json({ ok: true, genderRestriction });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'update_block_failed' });
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


/* --------------------- Smart Reserve and Reservation APIs --------------------- */

// Note: per-block availability queries were replaced with a single prefetch
// inside smart-reserve to minimize roundtrips. Keeping this helper for potential
// future use, but smart-reserve no longer calls it.
async function getAvailableBedsForBlock(blockId, blockSize) {
  const occ = await execQuery(`
    SELECT bed_number FROM allocations
    WHERE block_id = $1 AND deleted_at IS NULL AND end_date >= (CURRENT_DATE AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
      AND (status = 'confirmed' OR (status = 'reserved' AND reserved_expires_at > (NOW() AT TIME ZONE 'Asia/Kolkata')))
  `, [blockId]);
  const occupied = new Set(occ.rows.map(r => r.bed_number));
  const free = [];
  for (let i = 1; i <= blockSize; i++) if (!occupied.has(i)) free.push(i);
  return free;
}

// POST /api/allocations/smart-reserve
// body: { phone, contactName?, isFamily, maleCount, femaleCount, startDate, endDate, confirmFallback? }
app.post('/api/allocations/smart-reserve', async (req, res) => {
  try {
    const { phone, contactName, isFamily, maleCount = 0, femaleCount = 0, startDate, endDate, confirmFallback = false } = req.body || {};
    if (!phone || typeof isFamily !== 'boolean' || !startDate || !endDate) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    // Validate date range
    if (new Date(startDate) > new Date(endDate)) {
      return res.status(400).json({ error: 'invalid_date_range', message: 'start_date must be before or equal to end_date' });
    }

    const totalCount = Number(maleCount) + Number(femaleCount);
    if (totalCount <= 0) {
      return res.status(400).json({ error: 'invalid_count', message: 'At least one person must be specified' });
    }

    // Fetch locations and blocks with sizes and restrictions
    const locRes = await execQuery(`SELECT id, capacity FROM locations ORDER BY id`);
    const tentRes = await execQuery(`SELECT id, location_id, tent_index FROM tents ORDER BY location_id, tent_index`);
    const blockRes = await execQuery(`
      SELECT b.id, b.tent_id, t.location_id, t.tent_index, b.block_index, b.size, b.gender_restriction
      FROM blocks b JOIN tents t ON t.id = b.tent_id
      ORDER BY t.location_id, t.tent_index, b.block_index
    `);

    // Build maps for quick lookup
    const tentsByLoc = new Map();
    tentRes.rows.forEach(t => {
      if (!tentsByLoc.has(t.location_id)) tentsByLoc.set(t.location_id, []);
      tentsByLoc.get(t.location_id).push(t);
    });
    const blocksByTent = new Map();
    blockRes.rows.forEach(b => {
      if (!blocksByTent.has(b.tent_id)) blocksByTent.set(b.tent_id, []);
      blocksByTent.get(b.tent_id).push(b);
    });

    // Prefetch occupancy for all blocks that OVERLAP the requested date range.
    const occRes = await execQuery(`
      SELECT block_id, bed_number
      FROM allocations
      WHERE deleted_at IS NULL
        AND daterange(start_date, end_date, '[]') && daterange($1::date, $2::date, '[]')
        AND (status = 'confirmed' OR (status = 'reserved' AND reserved_expires_at > (NOW() AT TIME ZONE 'Asia/Kolkata')))
    `, [startDate, endDate]);
    const occupiedByBlock = new Map(); // block_id -> Set of occupied
    for (const r of occRes.rows) {
      const bid = Number(r.block_id);
      const set = occupiedByBlock.get(bid) || new Set();
      set.add(Number(r.bed_number));
      occupiedByBlock.set(bid, set);
    }
    const freeBedsByBlock = new Map(); // block_id -> Array of free beds (ascending)
    for (const b of blockRes.rows) {
      const occ = occupiedByBlock.get(b.id) || new Set();
      const arr = [];
      for (let i = 1; i <= Number(b.size); i++) if (!occ.has(i)) arr.push(i);
      freeBedsByBlock.set(b.id, arr);
    }

    // Helper: try to plan in a given location id (used by family-first passes)
    const tryPlanInLocation = async (locationId) => {
      // Gather candidate tents in location
      const tents = (tentsByLoc.get(locationId) || []).slice().sort((a,b)=>a.tent_index-b.tent_index);
      if (tents.length === 0) return null;

      // Clone freeBedsByBlock for this attempt so we don't mutate the original
      const localFreeBeds = new Map();
      for (const [blockId, beds] of freeBedsByBlock.entries()) {
        localFreeBeds.set(blockId, [...beds]); // shallow copy array
      }

      const planItems = [];
      const reserve = (block, count, gender) => {
        const freeList = localFreeBeds.get(block.id) || [];
        const take = Math.min(freeList.length, count);
        const picked = freeList.splice(0, take); // mutate local copy
        for (const bed of picked) {
          planItems.push({
            locationId,
            tentId: block.tent_id,
            blockId: block.id,
            tentIndex: block.tent_index,
            blockIndex: block.block_index,
            bedNumber: bed,
            gender,
          });
        }
        return take;
      };

      if (isFamily) {
        const need = totalCount;
        // Prefer single mixed block in same tent
        for (const t of tents) {
          const blocks = (blocksByTent.get(t.id) || []).filter(b=>b.gender_restriction==='both').sort((a,b)=>a.block_index-b.block_index);
          for (const b of blocks) {
            const free = localFreeBeds.get(b.id) || [];
            if (free.length >= need) {
              reserve(b, need, 'Female'); // gender irrelevant mix; split below
              // Adjust genders across the reserved items: rewrite last maleCount as 'Male'
              let malesLeft = Number(maleCount);
              for (let i = planItems.length - 1; i >= 0 && malesLeft > 0; i--) {
                planItems[i].gender = 'Male';
                malesLeft--;
              }
              return { items: planItems, requiresConfirmation: null };
            }
          }
        }
        // Else pack across mixed blocks within the same tent first
        for (const t of tents) {
          const blocks = (blocksByTent.get(t.id) || []).filter(b=>b.gender_restriction==='both').sort((a,b)=>a.block_index-b.block_index);
          let remaining = need;
          const startLen = planItems.length;
          for (const b of blocks) {
            const got = reserve(b, remaining, 'Female');
            remaining -= got;
            if (remaining <= 0) break;
          }
          if (remaining <= 0) {
            // Set genders: assign males over the last allocated
            let malesLeft = Number(maleCount);
            for (let i = planItems.length - 1; i >= startLen && malesLeft > 0; i--) {
              planItems[i].gender = 'Male';
              malesLeft--;
            }
            // Splitting across blocks in same tent; prompt if needed
            return { items: planItems, requiresConfirmation: 'split' };
          }
        }
        // Else split across tents in same location
        let remaining = need;
        const startLen = planItems.length;
        for (const t of tents) {
          const blocks = (blocksByTent.get(t.id) || []).filter(b=>b.gender_restriction==='both').sort((a,b)=>a.block_index-b.block_index);
          for (const b of blocks) {
            const got = reserve(b, remaining, 'Female');
            remaining -= got;
            if (remaining <= 0) break;
          }
          if (remaining <= 0) break;
        }
        if (remaining <= 0) {
          let malesLeft = Number(maleCount);
          for (let i = planItems.length - 1; i >= 0 && malesLeft > 0; i--) {
            planItems[i].gender = 'Male';
            malesLeft--;
          }
          return { items: planItems, requiresConfirmation: 'split' };
        }
        return null; // cannot satisfy
      } else {
        // Non-family handled at global scope across locations; this per-location planner isn't used
        // for non-family anymore. Return null so outer logic can proceed.
        return null;
      }
    };

    let finalPlan = null;

    if (isFamily) {
      // Prefer solutions within a single location first
      for (const loc of locRes.rows) {
        const resPlan = await tryPlanInLocation(loc.id);
        if (resPlan) { finalPlan = resPlan; break; }
      }
      if (!finalPlan) {
        // Check if there are any 'both' blocks available globally
        const blocksMixed = blockRes.rows.filter(b=>b.gender_restriction==='both').sort((a,b)=>a.location_id-b.location_id || a.tent_index-b.tent_index || a.block_index-b.block_index);
        const totalMixedCapacity = blocksMixed.reduce((sum, b) => sum + (freeBedsByBlock.get(b.id) || []).length, 0);
        
        if (totalMixedCapacity < totalCount) {
          // Not enough 'both' blocks, need to use single-gender blocks
          if (!confirmFallback) {
            return res.status(409).json({
              error: 'requires_confirmation',
              requiresConfirmation: 'no-mixed-blocks-family',
              message: 'No all-gender blocks available with sufficient capacity for family. Would you like to allocate in single-gender blocks instead?',
              preview: []
            });
          }
          
          // User confirmed - allocate maximum pairs in 'both' blocks, rest in single-gender
          const planItems = [];
          let malesRem = Number(maleCount);
          let femalesRem = Number(femaleCount);
          
          const reserveGlobal = (block, count, gender) => {
            const freeList = freeBedsByBlock.get(block.id) || [];
            const take = Math.min(freeList.length, count);
            const picked = freeList.splice(0, take);
            for (const bed of picked) {
              planItems.push({
                locationId: block.location_id,
                tentId: block.tent_id,
                blockId: block.id,
                tentIndex: block.tent_index,
                blockIndex: block.block_index,
                bedNumber: bed,
                gender,
              });
            }
            return take;
          };
          
          // Calculate max pairs (1 male + 1 female) that can fit in 'both' blocks
          const maxPossiblePairs = Math.min(
            Math.floor(totalMixedCapacity / 2), // max pairs based on space
            Math.min(malesRem, femalesRem) // max pairs based on available people
          );
          
          console.log('[FAMILY ALLOC] Total mixed capacity:', totalMixedCapacity);
          console.log('[FAMILY ALLOC] Males remaining:', malesRem, 'Females remaining:', femalesRem);
          console.log('[FAMILY ALLOC] Max possible pairs:', maxPossiblePairs);
          console.log('[FAMILY ALLOC] Mixed blocks available:', blocksMixed.length);
          
          // Allocate pairs to 'both' blocks - distribute evenly
          let pairsToAllocate = maxPossiblePairs;
          for (const b of blocksMixed) {
            if (pairsToAllocate <= 0) break;
            
            const freeInBlock = (freeBedsByBlock.get(b.id) || []).length;
            console.log(`[FAMILY ALLOC] Block ${b.id} (L${b.location_id} T${b.tent_index} B${b.block_index}): ${freeInBlock} free beds`);
            if (freeInBlock < 2) continue; // need at least 2 beds for a pair
            
            // Allocate as many pairs as possible in this block
            const pairsInThisBlock = Math.min(pairsToAllocate, Math.floor(freeInBlock / 2));
            console.log(`[FAMILY ALLOC] Allocating ${pairsInThisBlock} pairs to this block`);
            for (let i = 0; i < pairsInThisBlock; i++) {
              reserveGlobal(b, 1, 'Male');
              reserveGlobal(b, 1, 'Female');
            }
            pairsToAllocate -= pairsInThisBlock;
            malesRem -= pairsInThisBlock;
            femalesRem -= pairsInThisBlock;
          }
          
          console.log('[FAMILY ALLOC] After pairs - Males rem:', malesRem, 'Females rem:', femalesRem);
          
          // Now use any remaining capacity in 'both' blocks for individuals
          // Try to keep some balance between males and females even in leftover allocation
          for (const b of blocksMixed) {
            if (malesRem <= 0 && femalesRem <= 0) break;
            
            const freeInBlock = (freeBedsByBlock.get(b.id) || []).length;
            if (freeInBlock === 0) continue;
            
            // Alternate or balance allocation in remaining capacity
            while ((freeBedsByBlock.get(b.id) || []).length > 0 && (malesRem > 0 || femalesRem > 0)) {
              // If we have both males and females remaining, alternate
              if (malesRem > 0 && femalesRem > 0) {
                reserveGlobal(b, 1, 'Male');
                malesRem -= 1;
                if ((freeBedsByBlock.get(b.id) || []).length > 0 && femalesRem > 0) {
                  reserveGlobal(b, 1, 'Female');
                  femalesRem -= 1;
                }
              } else if (malesRem > 0) {
                reserveGlobal(b, 1, 'Male');
                malesRem -= 1;
              } else if (femalesRem > 0) {
                reserveGlobal(b, 1, 'Female');
                femalesRem -= 1;
              }
            }
          }
          
          // Now allocate remaining males to male_only blocks
          if (malesRem > 0) {
            const maleBlocks = blockRes.rows
              .filter(b => b.gender_restriction === 'male_only')
              .sort((a,b)=>a.location_id-b.location_id || a.tent_index-b.tent_index || a.block_index-b.block_index);
            for (const b of maleBlocks) {
              if (malesRem <= 0) break;
              const got = reserveGlobal(b, malesRem, 'Male');
              malesRem -= got;
            }
          }
          
          // Allocate remaining females to female_only blocks
          if (femalesRem > 0) {
            const femaleBlocks = blockRes.rows
              .filter(b => b.gender_restriction === 'female_only')
              .sort((a,b)=>a.location_id-b.location_id || a.tent_index-b.tent_index || a.block_index-b.block_index);
            for (const b of femaleBlocks) {
              if (femalesRem <= 0) break;
              const got = reserveGlobal(b, femalesRem, 'Female');
              femalesRem -= got;
            }
          }
          
          if (malesRem <= 0 && femalesRem <= 0) {
            finalPlan = { items: planItems, requiresConfirmation: 'split' };
          }
        } else {
          // Enough 'both' blocks available - allocate pairs across locations
          console.log('[FAMILY ENOUGH MIXED] Total mixed capacity:', totalMixedCapacity, 'Total needed:', totalCount);
          const planItems = [];
          let malesRem = Number(maleCount);
          let femalesRem = Number(femaleCount);
          
          const reserveGlobal = (block, count, gender) => {
            const freeList = freeBedsByBlock.get(block.id) || [];
            const take = Math.min(freeList.length, count);
            const picked = freeList.splice(0, take);
            for (const bed of picked) {
              planItems.push({
                locationId: block.location_id,
                tentId: block.tent_id,
                blockId: block.id,
                tentIndex: block.tent_index,
                blockIndex: block.block_index,
                bedNumber: bed,
                gender,
              });
            }
            return take;
          };
          
          // Calculate max pairs that fit
          const maxPossiblePairs = Math.min(
            Math.floor(totalMixedCapacity / 2),
            Math.min(malesRem, femalesRem)
          );
          
          console.log('[FAMILY ENOUGH MIXED] Max pairs:', maxPossiblePairs);
          
          // Allocate pairs across all 'both' blocks
          let pairsToAllocate = maxPossiblePairs;
          for (const b of blocksMixed) {
            if (pairsToAllocate <= 0) break;
            
            const freeInBlock = (freeBedsByBlock.get(b.id) || []).length;
            if (freeInBlock < 2) continue;
            
            const pairsInThisBlock = Math.min(pairsToAllocate, Math.floor(freeInBlock / 2));
            console.log(`[FAMILY ENOUGH MIXED] Block ${b.id}: allocating ${pairsInThisBlock} pairs`);
            for (let i = 0; i < pairsInThisBlock; i++) {
              reserveGlobal(b, 1, 'Male');
              reserveGlobal(b, 1, 'Female');
            }
            pairsToAllocate -= pairsInThisBlock;
            malesRem -= pairsInThisBlock;
            femalesRem -= pairsInThisBlock;
          }
          
          console.log('[FAMILY ENOUGH MIXED] After pairs - Males rem:', malesRem, 'Females rem:', femalesRem);
          
          // Use remaining capacity in 'both' blocks - alternate genders
          for (const b of blocksMixed) {
            if (malesRem <= 0 && femalesRem <= 0) break;
            
            const freeInBlock = (freeBedsByBlock.get(b.id) || []).length;
            if (freeInBlock === 0) continue;
            
            while ((freeBedsByBlock.get(b.id) || []).length > 0 && (malesRem > 0 || femalesRem > 0)) {
              if (malesRem > 0 && femalesRem > 0) {
                reserveGlobal(b, 1, 'Male');
                malesRem -= 1;
                if ((freeBedsByBlock.get(b.id) || []).length > 0 && femalesRem > 0) {
                  reserveGlobal(b, 1, 'Female');
                  femalesRem -= 1;
                }
              } else if (malesRem > 0) {
                reserveGlobal(b, 1, 'Male');
                malesRem -= 1;
              } else if (femalesRem > 0) {
                reserveGlobal(b, 1, 'Female');
                femalesRem -= 1;
              }
            }
          }
          
          if (malesRem <= 0 && femalesRem <= 0) {
            finalPlan = { items: planItems, requiresConfirmation: 'split' };
          }
        }
      }
    } else {
      // Non-family: allocate across ALL locations using single-gender blocks first; only then consider mixed
      let malesRem = Number(maleCount);
      let femalesRem = Number(femaleCount);
      const planItems = [];
      const reserveGlobal = (block, count, gender) => {
        const freeList = freeBedsByBlock.get(block.id) || [];
        const take = Math.min(freeList.length, count);
        const picked = freeList.splice(0, take);
        for (const bed of picked) {
          planItems.push({
            locationId: block.location_id,
            tentId: block.tent_id,
            blockId: block.id,
            tentIndex: block.tent_index,
            blockIndex: block.block_index,
            bedNumber: bed,
            gender,
          });
        }
        return take;
      };
      const allocateAcross = (gender, restrictions) => {
        const blocks = blockRes.rows
          .filter(b=>restrictions.includes(b.gender_restriction))
          .sort((a,b)=>a.location_id-b.location_id || a.tent_index-b.tent_index || a.block_index-b.block_index);
        for (const b of blocks) {
          const need = gender==='Male' ? malesRem : femalesRem;
          if (need<=0) break;
          const got = reserveGlobal(b, need, gender);
          if (gender==='Male') malesRem -= got; else femalesRem -= got;
          if (malesRem<=0 && femalesRem<=0) return;
        }
      };

      // Strict single-gender across all locations
      allocateAcross('Male', ['male_only']);
      allocateAcross('Female', ['female_only']);

      if (malesRem>0 || femalesRem>0) {
        if (!confirmFallback) {
          return res.status(409).json({
            error: 'requires_confirmation',
            requiresConfirmation: 'mixed-blocks',
            message: 'Single-gender blocks across all locations are insufficient. Fallback to mixed blocks is required.',
            preview: planItems.map(i=>({ locationId: i.locationId, tentIndex: i.tentIndex, blockIndex: i.blockIndex, bedNumber: i.bedNumber, gender: i.gender }))
          });
        }
        // Allow mixed across all locations
        allocateAcross('Male', ['both']);
        allocateAcross('Female', ['both']);
      }

      if (malesRem<=0 && femalesRem<=0) finalPlan = { items: planItems, requiresConfirmation: null };
    }

    if (!finalPlan) {
      return res.status(400).json({ error: 'insufficient_beds', message: 'Unable to satisfy reservation with current capacity' });
    }

    if (finalPlan.requiresConfirmation && !confirmFallback) {
      return res.status(409).json({
        error: 'requires_confirmation',
        requiresConfirmation: finalPlan.requiresConfirmation,
        message: finalPlan.requiresConfirmation === 'mixed-blocks'
          ? 'Single-gender blocks are insufficient. Fallback to mixed blocks is required.'
          : 'Keeping the group together is not fully possible. Splitting across blocks/tents/locations is required.',
        preview: finalPlan.items.map(i=>({ locationId: i.locationId, tentIndex: i.tentIndex, blockIndex: i.blockIndex, bedNumber: i.bedNumber, gender: i.gender }))
      });
    }

    // Proceed to insert reservation rows
    const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    const expiresAt = new Date(Date.now() + (config.reservationTTLHours * 60 * 60 * 1000));

    await execQuery('BEGIN');
    try {
      const cols = `location_id, tent_id, block_id, tent_index, block_index, bed_number, name, phone, gender, start_date, end_date, status, batch_id, contact_name, is_family, reserved_expires_at`;
      
      // Batch insert to avoid parameter limit (PostgreSQL limit is ~65535 params)
      const batchSize = 500; // 500 rows * 15 params = 7500 params per batch (safe)
      for (let i = 0; i < finalPlan.items.length; i += batchSize) {
        const chunk = finalPlan.items.slice(i, i + batchSize);
        const values = [];
        const params = [];
        let p = 1;
        
        for (const item of chunk) {
          values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},'reserved',$${p++},$${p++},$${p++},$${p++})`);
          params.push(
            item.locationId, item.tentId, item.blockId, item.tentIndex, item.blockIndex, item.bedNumber,
            contactName || 'Reserved', phone, item.gender, startDate, endDate,
            batchId, contactName || null, !!isFamily, expiresAt
          );
        }
        
        const sql = `INSERT INTO allocations(${cols}) VALUES ${values.join(',')}`;
        await execQuery(sql, params);
      }
      
      await execQuery('COMMIT');
    } catch (e) {
      await execQuery('ROLLBACK');
      if (e.code === '23P01') {
        return res.status(409).json({ error: 'overlapping_allocation' });
      }
      throw e;
    }

    // Determine if a single location or multiple were used
    const locSet = new Set(finalPlan.items.map(i=>i.locationId));
    const singleLocationId = locSet.size === 1 ? finalPlan.items[0].locationId : null;

    return res.json({
      ok: true,
      batchId,
      locationId: singleLocationId,
      items: finalPlan.items.map(i=>({ locationId: i.locationId, tentIndex: i.tentIndex, blockIndex: i.blockIndex, bedNumber: i.bedNumber, gender: i.gender }))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'smart_reserve_failed', message: e.message });
  }
});

// GET /api/allocations/by-phone?phone=...
app.get('/api/allocations/by-phone', async (req, res) => {
  try {
    const phone = String(req.query.phone || '').trim();
    if (!phone) return res.status(400).json({ error: 'missing_phone' });
    const user = getUserFromRequest(req);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });

    const rows = await execQuery(`
      SELECT id, batch_id, status, reserved_expires_at, location_id, tent_index, block_index, bed_number, gender, start_date, end_date
      FROM allocations
      WHERE phone = $1 AND deleted_at IS NULL
      ORDER BY batch_id NULLS LAST, created_at DESC
    `, [phone]);

    const batches = {};
    for (const r of rows.rows) {
      const key = r.batch_id || `single_${r.id}`;
      if (!batches[key]) batches[key] = { batchId: r.batch_id || null, items: [], statuses: new Set(), expiresAt: null };
      batches[key].items.push({
        id: Number(r.id), locationId: Number(r.location_id), tentIndex: Number(r.tent_index), blockIndex: Number(r.block_index), bedNumber: Number(r.bed_number),
        gender: r.gender, status: r.status, startDate: r.start_date, endDate: r.end_date
      });
      batches[key].statuses.add(r.status);
      if (r.status === 'reserved' && r.reserved_expires_at && (!batches[key].expiresAt || batches[key].expiresAt < r.reserved_expires_at)) {
        batches[key].expiresAt = r.reserved_expires_at;
      }
    }

    const result = Object.values(batches).map(b => ({
      batchId: b.batchId,
      statuses: Array.from(b.statuses),
      expiresAt: b.expiresAt,
      items: b.items
    }));
    res.json({ ok: true, batches: result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'fetch_by_phone_failed' });
  }
});

// PATCH /api/allocations/by-phone/update-phone
// body: { oldPhone, newPhone, batchId?, allocationIds? }
app.patch('/api/allocations/by-phone/update-phone', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const { oldPhone, newPhone, batchId, allocationIds } = req.body || {};
    if (!oldPhone || !newPhone) return res.status(400).json({ error: 'missing_phone' });

    const params = [oldPhone, newPhone];
    let q = `UPDATE allocations SET phone = $2, updated_at = NOW() WHERE phone = $1 AND deleted_at IS NULL`;
    if (batchId) { q += ` AND batch_id = $3`; params.push(batchId); }
    if (Array.isArray(allocationIds) && allocationIds.length) {
      const placeholders = allocationIds.map((_, i) => `$${params.length + i + 1}`).join(',');
      q += ` AND id IN (${placeholders})`;
      params.push(...allocationIds);
    }

    const r = await execQuery(q, params);
    res.json({ ok: true, updated: r.rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'update_phone_failed' });
  }
});

// PATCH /api/allocations/by-phone/update-contact
// body: { phone, contactName, batchId? }
app.patch('/api/allocations/by-phone/update-contact', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const { phone, contactName, batchId } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'missing_phone' });

    const params = [contactName || null, phone];
    let q = `UPDATE allocations SET contact_name = $1, updated_at = NOW() WHERE phone = $2 AND deleted_at IS NULL`;
    if (batchId) { q += ` AND batch_id = $3`; params.push(batchId); }

    const r = await execQuery(q, params);
    res.json({ ok: true, updated: r.rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'update_contact_failed' });
  }
});

// PATCH /api/allocations/by-phone/update-end-date
// body: { phone, endDate, batchId?, allocationIds? }
app.patch('/api/allocations/by-phone/update-end-date', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const { phone, endDate, batchId, allocationIds } = req.body || {};
    if (!phone || !endDate) return res.status(400).json({ error: 'missing_fields' });

    let base = `UPDATE allocations SET end_date = $1, updated_at = NOW() WHERE phone = $2 AND deleted_at IS NULL`;
    const params = [endDate, phone];
    if (batchId) { base += ` AND batch_id = $${params.push(batchId)}`; }
    if (Array.isArray(allocationIds) && allocationIds.length) {
      const placeholders = allocationIds.map((_, i) => `$${params.length + i + 1}`).join(',');
      base += ` AND id IN (${placeholders})`;
      params.push(...allocationIds);
    }
    const r = await execQuery(base, params);
    res.json({ ok: true, updated: r.rowCount });
  } catch (e) {
    console.error(e);
    if (e.code === '23P01') return res.status(409).json({ error: 'overlap_after_update' });
    res.status(500).json({ error: 'update_end_date_failed' });
  }
});

// POST /api/allocations/by-phone/deallocate
// body: { phone, batchId?, allocationIds? }
app.post('/api/allocations/by-phone/deallocate', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const { phone, batchId, allocationIds } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'missing_phone' });

    let base = `UPDATE allocations SET deleted_at = NOW(), updated_at = NOW() WHERE phone = $1 AND deleted_at IS NULL`;
    const params = [phone];
    if (batchId) { base += ` AND batch_id = $${params.push(batchId)}`; }
    if (Array.isArray(allocationIds) && allocationIds.length) {
      const placeholders = allocationIds.map((_, i) => `$${params.length + i + 1}`).join(',');
      base += ` AND id IN (${placeholders})`;
      params.push(...allocationIds);
    }
    const r = await execQuery(base, params);
    res.json({ ok: true, deallocated: r.rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'deallocate_failed' });
  }
});

// GET /api/allocations/departures?date=YYYY-MM-DD
app.get('/api/allocations/departures', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const date = String(req.query.date || '').trim();
    if (!date) return res.status(400).json({ error: 'missing_date' });

    const rows = await execQuery(`
      SELECT a.id, a.phone, a.contact_name, a.location_id, l.name as location_name, a.tent_index, a.block_index, a.bed_number, a.gender, a.status, a.start_date, a.end_date
      FROM allocations a
      LEFT JOIN locations l ON a.location_id = l.id
      WHERE a.deleted_at IS NULL AND a.end_date = $1
      ORDER BY a.location_id, a.tent_index, a.block_index, a.bed_number
    `, [date]);
    res.json({ ok: true, items: rows.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'departures_failed' });
  }
});

// GET /api/allocations/reserved-active
app.get('/api/allocations/reserved-active', async (_req, res) => {
  try {
    const user = getUserFromRequest(_req);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const rows = await execQuery(`
      SELECT a.id, a.batch_id, a.phone, a.contact_name, a.location_id, l.name as location_name, a.tent_index, a.block_index, a.bed_number, 
             a.reserved_expires_at, a.start_date, a.end_date, a.gender
      FROM allocations a
      LEFT JOIN locations l ON a.location_id = l.id
      WHERE a.deleted_at IS NULL AND a.status = 'reserved' AND (a.reserved_expires_at IS NULL OR a.reserved_expires_at > (NOW() AT TIME ZONE 'Asia/Kolkata'))
      ORDER BY a.location_id, a.tent_index, a.block_index, a.batch_id, a.created_at
    `);
    res.json({ ok: true, items: rows.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'reserved_active_failed' });
  }
});

// POST /api/allocations/confirm
// body: { batchId, allocationIds? }
app.post('/api/allocations/confirm', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const { batchId, allocationIds } = req.body || {};
    if (!batchId) return res.status(400).json({ error: 'missing_batch' });

    await execQuery('BEGIN');
    try {
      // Select target rows (reserved and not expired)
      const target = await execQuery(`
        SELECT id FROM allocations
        WHERE batch_id = $1 AND status = 'reserved' AND (reserved_expires_at IS NULL OR reserved_expires_at > (NOW() AT TIME ZONE 'Asia/Kolkata'))
      `, [batchId]);

      let ids = target.rows.map(r=>r.id);
      if (Array.isArray(allocationIds) && allocationIds.length) {
        const set = new Set(allocationIds.map(Number));
        ids = ids.filter(id => set.has(Number(id)));
      }
      if (!ids.length) {
        await execQuery('ROLLBACK');
        return res.status(400).json({ error: 'nothing_to_confirm' });
      }

      // Flip to confirmed
      const placeholders = ids.map((_,i)=>`$${i+2}`).join(',');
      await execQuery(`
        UPDATE allocations SET status = 'confirmed', updated_at = NOW()
        WHERE batch_id = $1 AND id IN (${placeholders})
      `, [batchId, ...ids]);

      await execQuery('COMMIT');
      res.json({ ok: true, confirmedIds: ids });
    } catch (e) {
      await execQuery('ROLLBACK');
      throw e;
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'confirm_failed' });
  }
});

// POST /api/allocations/cleanup-expired - Admin only endpoint to clean up expired reservations
app.post('/api/allocations/cleanup-expired', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });

    // Soft-delete all expired reservations
    const result = await execQuery(`
      UPDATE allocations
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE deleted_at IS NULL
        AND status = 'reserved'
        AND reserved_expires_at IS NOT NULL
        AND reserved_expires_at <= ${nowIST}
    `);

    res.json({ ok: true, cleaned: result.rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'cleanup_failed' });
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

    // Validate date range
    if (new Date(startDate) > new Date(endDate)) {
      return res.status(400).json({ error: 'invalid_date_range', message: 'start_date must be before or equal to end_date' });
    }

    // Validate and normalize gender
    const validGenders = ['Male', 'Female', 'Other'];
    const normalizedGender = gender && gender.trim() && validGenders.includes(gender.trim()) 
      ? gender.trim() 
      : 'Other';

    // Validate gender restriction for the block
    try {
      await validateGenderRestriction(locationId, tentIndex, blockIndex, normalizedGender);
    } catch (e) {
      return res.status(400).json({ error: 'gender_restriction_violation', message: e.message });
    }

    // Get tent_id for the allocation
    const tentRes = await execQuery(`
      SELECT id FROM tents WHERE location_id = $1 AND tent_index = $2
    `, [locationId, tentIndex]);
    const tentId = tentRes.rows[0].id;

    // Cleanup: soft-delete expired reservations that overlap this range for this bed in this block
    try {
      await execQuery(`
        UPDATE allocations
        SET deleted_at = NOW(), updated_at = NOW()
        WHERE block_id = $1
          AND bed_number = $2
          AND status = 'reserved'
          AND reserved_expires_at IS NOT NULL
          AND reserved_expires_at <= ${nowIST}
          AND deleted_at IS NULL
          AND daterange(start_date, end_date, '[]') && daterange($3::date, $4::date, '[]')
      `, [blockId, bedNumber, startDate, endDate]);
    } catch {}

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
      normalizedGender,
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

// POST /api/locations/:id/tents/:tent/blocks/:block/beds/bulk-allocate
app.post('/api/locations/:id/tents/:tent/blocks/:block/beds/bulk-allocate', async (req, res) => {
  try {
    const locationId = Number(req.params.id);
    const tentIndex = Number(req.params.tent);
    const blockIndex = Number(req.params.block);
    
    const { name, phone, maleCount, femaleCount, startDate, endDate } = req.body || {};
    
    if (!name || !startDate || !endDate) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    // Validate date range
    if (new Date(startDate) > new Date(endDate)) {
      return res.status(400).json({ error: 'invalid_date_range', message: 'start_date must be before or equal to end_date' });
    }

    const totalCount = (maleCount || 0) + (femaleCount || 0);
    if (totalCount <= 0) {
      return res.status(400).json({ error: 'invalid_count', message: 'At least one person must be specified' });
    }

    // Get block info
    const blockRes = await execQuery(`
      SELECT b.id, b.size
      FROM blocks b
      JOIN tents t ON t.id = b.tent_id
      WHERE t.location_id = $1 AND t.tent_index = $2 AND b.block_index = $3
    `, [locationId, tentIndex, blockIndex]);
    
    if (!blockRes.rowCount) {
      return res.status(404).json({ error: 'block_not_found' });
    }
    
    const blockId = blockRes.rows[0].id;
    const blockSize = blockRes.rows[0].size;

    // Get tent_id
    const tentRes = await execQuery(`
      SELECT id FROM tents WHERE location_id = $1 AND tent_index = $2
    `, [locationId, tentIndex]);
    const tentId = tentRes.rows[0].id;

    // Find available beds in this block
    const occupiedRes = await execQuery(`
      SELECT bed_number 
      FROM allocations 
      WHERE block_id = $1 
        AND deleted_at IS NULL 
        AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')
        AND (status = 'confirmed' OR (status = 'reserved' AND reserved_expires_at > (NOW() AT TIME ZONE 'Asia/Kolkata')))
    `, [blockId, startDate, endDate]);
    
    const occupiedBeds = new Set(occupiedRes.rows.map(r => r.bed_number));
    const availableBeds = [];
    
    for (let bedNum = 1; bedNum <= blockSize; bedNum++) {
      if (!occupiedBeds.has(bedNum)) {
        availableBeds.push(bedNum);
      }
    }

    if (availableBeds.length < totalCount) {
      return res.status(400).json({ 
        error: 'insufficient_beds', 
        message: `Not enough available beds. Need ${totalCount}, but only ${availableBeds.length} available.`,
        available: availableBeds.length,
        needed: totalCount
      });
    }

    // Begin transaction for bulk insert
    await execQuery('BEGIN');

    const success = [];
    const errors = [];
    let bedIndex = 0;

    try {
      // Allocate male beds
      for (let i = 0; i < (maleCount || 0); i++) {
        const bedNumber = availableBeds[bedIndex++];
        
        try {
          // Validate gender restriction (block level)
          await validateGenderRestriction(locationId, tentIndex, blockIndex, 'Male');
          
          await execQuery(`
            INSERT INTO allocations(location_id, tent_id, block_id, tent_index, block_index, bed_number, name, phone, gender, start_date, end_date)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          `, [locationId, tentId, blockId, tentIndex, blockIndex, bedNumber, name, phone || null, 'Male', startDate, endDate]);
          
          success.push({ bedNumber, gender: 'Male', name });
        } catch (e) {
          errors.push({ bedNumber, gender: 'Male', message: e.message || 'Failed to allocate bed' });
        }
      }

      // Allocate female beds
      for (let i = 0; i < (femaleCount || 0); i++) {
        const bedNumber = availableBeds[bedIndex++];
        
        try {
          // Validate gender restriction (block level)
          await validateGenderRestriction(locationId, tentIndex, blockIndex, 'Female');
          
          await execQuery(`
            INSERT INTO allocations(location_id, tent_id, block_id, tent_index, block_index, bed_number, name, phone, gender, start_date, end_date)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          `, [locationId, tentId, blockId, tentIndex, blockIndex, bedNumber, name, phone || null, 'Female', startDate, endDate]);
          
          success.push({ bedNumber, gender: 'Female', name });
        } catch (e) {
          errors.push({ bedNumber, gender: 'Female', message: e.message || 'Failed to allocate bed' });
        }
      }

      await execQuery('COMMIT');
      
      res.json({ 
        ok: true, 
        success, 
        errors,
        total: totalCount,
        allocated: success.length
      });
    } catch (e) {
      await execQuery('ROLLBACK');
      throw e;
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'bulk_allocate_failed', message: e.message });
  }
});

// PATCH /api/locations/:id/tents/:tent/blocks/:block/beds/:bedNumber
// body: partial { name, phone, gender, startDate, endDate }
// soft deletes current allocation and creates new one (preserves history)
app.patch('/api/locations/:id/tents/:tent/blocks/:block/beds/:bedNumber', async (req, res) => {
  try {
    const locationId = Number(req.params.id);
    const tentIndex = Number(req.params.tent);
    const blockIndex = Number(req.params.block);
    const bedNumber = Number(req.params.bedNumber);
    if (!Number.isFinite(bedNumber)) return res.status(400).json({ error: 'invalid_bed_number' });
    
    const blockId = await validateBedWithinBlock(locationId, tentIndex, blockIndex, bedNumber);

    // Find current active allocation
    const findQ = `
      SELECT id, name, phone, gender, start_date, end_date FROM allocations
      WHERE block_id = $1
        AND bed_number = $2
        AND deleted_at IS NULL
        AND end_date >= (CURRENT_DATE AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const active = await execQuery(findQ, [blockId, bedNumber]);
    if (!active.rowCount) return res.status(404).json({ error: 'no_active_allocation' });

    const current = active.rows[0];
    const { name, phone, gender, startDate, endDate } = req.body || {};

    // Use current values as defaults for missing fields
    const newName = name !== undefined ? name : current.name;
    const newPhone = phone !== undefined ? phone : current.phone;
    const newGender = gender !== undefined ? (
      gender && gender.trim() && ['Male', 'Female', 'Other'].includes(gender.trim()) 
        ? gender.trim() 
        : 'Other'
    ) : current.gender;
    const newStartDate = startDate !== undefined ? startDate : current.start_date.toISOString().split('T')[0];
    const newEndDate = endDate !== undefined ? endDate : current.end_date.toISOString().split('T')[0];

    // Validate gender restriction for the block if gender is being changed
    if (gender !== undefined) {
      try {
        await validateGenderRestriction(locationId, tentIndex, blockIndex, newGender);
      } catch (e) {
        return res.status(400).json({ error: 'gender_restriction_violation', message: e.message });
      }
    }

    // Get tent_id for the allocation
    const tentRes = await execQuery(`
      SELECT id FROM tents WHERE location_id = $1 AND tent_index = $2
    `, [locationId, tentIndex]);
    const tentId = tentRes.rows[0].id;

    // Begin transaction
    await execQuery('BEGIN');

    try {
      // Soft delete current allocation
      await execQuery(
        `UPDATE allocations SET deleted_at = NOW() WHERE id = $1`,
        [current.id]
      );

      // Create new allocation with updated values
      const insertQ = `
        INSERT INTO allocations(location_id, tent_id, block_id, tent_index, block_index, bed_number, name, phone, gender, start_date, end_date)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id
      `;
      await execQuery(insertQ, [
        locationId,
        tentId,
        blockId,
        tentIndex,
        blockIndex,
        bedNumber,
        newName,
        newPhone,
        newGender,
        newStartDate,
        newEndDate
      ]);

      await execQuery('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await execQuery('ROLLBACK');
      throw e;
    }
  } catch (e) {
    console.error(e);
    if (e.code === '23P01') {
      return res.status(409).json({ error: 'overlapping_allocation' });
    }
    res.status(500).json({ error: 'edit_failed' });
  }
});

// DELETE /api/locations/:id/tents/:tent/blocks/:block/beds/:bedNumber (soft delete)
app.delete('/api/locations/:id/tents/:tent/blocks/:block/beds/:bedNumber', async (req, res) => {
  try {
    const locationId = Number(req.params.id);
    const tentIndex = Number(req.params.tent);
    const blockIndex = Number(req.params.block);
    const bedNumber = Number(req.params.bedNumber);
    
    const blockId = await validateBedWithinBlock(locationId, tentIndex, blockIndex, bedNumber);

    const delQ = `
      UPDATE allocations 
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE id IN (
        SELECT id FROM allocations
        WHERE block_id = $1
          AND bed_number = $2
          AND deleted_at IS NULL
          AND end_date >= (CURRENT_DATE AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
        ORDER BY created_at DESC
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

// POST /api/locations/:id/tents/:tent/blocks/:block/beds/deallocate-batch
// body: { bedNumbers: number[] }
app.post('/api/locations/:id/tents/:tent/blocks/:block/beds/deallocate-batch', async (req, res) => {
  try {
    const locationId = Number(req.params.id);
    const tentIndex = Number(req.params.tent);
    const blockIndex = Number(req.params.block);
    const bedNumbers = Array.isArray(req.body?.bedNumbers) ? req.body.bedNumbers.map(Number).filter(n=>Number.isFinite(n)) : [];
    if (bedNumbers.length === 0) return res.status(400).json({ error: 'no_beds' });

    // Validate block and obtain block_id
    const v = await execQuery(`
      SELECT b.id, b.size
      FROM blocks b JOIN tents t ON t.id = b.tent_id
      WHERE t.location_id = $1 AND t.tent_index = $2 AND b.block_index = $3
    `, [locationId, tentIndex, blockIndex]);
    if (!v.rowCount) return res.status(404).json({ error: 'block_not_found' });
    const blockId = Number(v.rows[0].id);

    // One set-based update to soft-delete latest active allocation per requested bed
    const sql = `
      WITH latest AS (
        SELECT id, bed_number
        FROM (
          SELECT a.id, a.bed_number, ROW_NUMBER() OVER (PARTITION BY a.bed_number ORDER BY a.created_at DESC) rn
          FROM allocations a
          WHERE a.block_id = $1
            AND a.bed_number = ANY($2::int[])
            AND a.deleted_at IS NULL
            AND a.end_date >= (CURRENT_DATE AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date
        ) s
        WHERE rn = 1
      ), upd AS (
        UPDATE allocations a
        SET deleted_at = NOW(), updated_at = NOW()
        FROM latest l
        WHERE a.id = l.id
        RETURNING l.bed_number
      )
      SELECT 
        (SELECT COUNT(*) FROM upd) AS success,
        (SELECT ARRAY(SELECT unnest($2::int[]) EXCEPT SELECT bed_number FROM latest)) AS no_active
    `;
    const r = await execQuery(sql, [blockId, bedNumbers]);
    const row = r.rows?.[0] || { success: 0, no_active: [] };
    const errors = (row.no_active || []).map(bn => ({ bedNumber: Number(bn), error: 'no_active_allocation' }));
    res.json({ ok: true, success: Number(row.success || 0), errors });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'deallocate_batch_failed' });
  }
});
