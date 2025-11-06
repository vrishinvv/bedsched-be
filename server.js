import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
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
  validateAndGetBlockInfo,
  getTodayIST,
  todaySQL, 
  tomorrowSQL,
  nowIST
} from './common/helpers.js';
import { generateUploadUrl, generateViewUrl } from './common/s3.js';


const app = express();

// Audit logging helper
async function logAudit(req, action, entityType, entityId, details = {}) {
  try {
    const user = getUserFromRequest(req);
    let userId = user?.id || null;
    const username = user?.username || 'anonymous';
    
    // If user_id is not in token/cookie, fetch it from database
    if (!userId && username !== 'anonymous') {
      const userQuery = await execQuery('SELECT id FROM users WHERE username = $1', [username]);
      userId = userQuery.rows[0]?.id || null;
    }
    
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress;
    
    await execQuery(`
      INSERT INTO audit_logs (user_id, username, action, entity_type, entity_id, details, ip_address)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [userId, username, action, entityType, entityId, JSON.stringify(details), ipAddress]);
  } catch (err) {
    console.error('[AUDIT] Failed to log:', err.message);
    // Don't throw - audit failure shouldn't break operations
  }
}

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
        return { username: payload.username, role: payload.role, id: payload.id, locationId: payload.locationId || null };
      }
    } catch (e) {
      // invalid token -> fall back to cookies
    }
  }
  const user = req.cookies?.bs_user;
  const role = req.cookies?.bs_role;
  const userId = req.cookies?.bs_user_id;
  const locationId = req.cookies?.bs_location_id;
  if (user && role) return { username: user, role, id: userId ? Number(userId) : null, locationId: locationId ? Number(locationId) : null };
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
      `SELECT id, username, password, role, location_id FROM users WHERE username = $1 LIMIT 1`,
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
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    };
    res.cookie('bs_user', u.username, cookieOptions);
    res.cookie('bs_role', u.role, cookieOptions);
    res.cookie('bs_user_id', u.id, cookieOptions);
    if (u.location_id) res.cookie('bs_location_id', u.location_id, cookieOptions);

    // Also return a signed JWT for token-based auth on platforms where cookies are unreliable
    const token = jwt.sign({ id: u.id, username: u.username, role: u.role, locationId: u.location_id }, config.jwtSecret, { expiresIn: '7d' });
    await logAudit(req, 'login', 'auth', u.id, { username: u.username, role: u.role });
    res.json({ ok: true, user: { username: u.username, role: u.role, locationId: u.location_id }, token });
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

// Debug endpoint to check allocation dates in a block
app.get('/api/debug/block-allocations/:blockId', async (req, res) => {
  try {
    const blockId = Number(req.params.blockId);
    
    const result = await execQuery(`
      SELECT 
        bed_number,
        name,
        phone,
        TO_CHAR(start_date, 'YYYY-MM-DD') as start_date_str,
        TO_CHAR(end_date, 'YYYY-MM-DD') as end_date_str,
        start_date,
        end_date,
        status,
        deleted_at,
        reserved_expires_at,
        CASE 
          WHEN end_date >= ${todaySQL} THEN 'CURRENT/FUTURE'
          ELSE 'PAST'
        END as backend_timeframe,
        CASE
          WHEN deleted_at IS NOT NULL THEN 'DELETED'
          WHEN status = 'confirmed' AND end_date >= ${todaySQL} THEN 'COUNTED_IN_STATS'
          WHEN status = 'reserved' AND reserved_expires_at > NOW() THEN 'RESERVED_ACTIVE'
          WHEN status = 'reserved' AND (reserved_expires_at IS NULL OR reserved_expires_at <= NOW()) THEN 'RESERVED_EXPIRED'
          ELSE 'PAST_NOT_COUNTED'
        END as backend_classification,
        CASE
          WHEN status = 'confirmed' THEN
            CASE 
              WHEN ${todaySQL} >= start_date AND ${todaySQL} <= end_date THEN 'SHOULD_BE_RED_OR_ORANGE'
              WHEN start_date > ${todaySQL} THEN 'SHOULD_BE_ORANGE'
              ELSE 'SHOULD_BE_WHITE'
            END
          WHEN status = 'reserved' AND (reserved_expires_at IS NULL OR reserved_expires_at > ${nowIST}) THEN 'SHOULD_BE_BLUE'
          ELSE 'SHOULD_BE_WHITE'
        END as expected_frontend_color
      FROM allocations
      WHERE block_id = $1
      ORDER BY 
        CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END,
        end_date DESC,
        bed_number
    `, [blockId]);
    
    const stats = await execQuery(`
      SELECT 
        COUNT(*) FILTER (WHERE deleted_at IS NULL) as total_active_records,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND end_date >= ${todaySQL}) as backend_returns_to_frontend,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND end_date < ${todaySQL}) as past_not_returned,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND end_date >= ${todaySQL} AND status = 'confirmed') as stats_pill_should_show,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND status = 'confirmed' AND ${todaySQL} >= start_date AND ${todaySQL} <= end_date) as should_be_red_or_orange,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND status = 'confirmed' AND start_date > ${todaySQL}) as should_be_orange,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND status = 'confirmed' AND end_date < ${todaySQL}) as should_be_white_past,
        ${todaySQL} as today_from_sql,
        CURRENT_DATE as current_date_utc
      FROM allocations
      WHERE block_id = $1
    `, [blockId]);
    
    res.json({
      blockId,
      todayIST: getTodayIST(),
      serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      serverTime: new Date().toISOString(),
      explanation: {
        backend_returns_to_frontend: "Beds with end_date >= TODAY (included in API response)",
        stats_pill_should_show: "Beds counted in 'allocated' stat (status=confirmed AND end_date >= TODAY)",
        should_be_red_or_orange: "Beds that should show as occupied in grid (current or future within range)",
        should_be_white_past: "Past allocations NOT returned to frontend",
        today_from_sql: "What PostgreSQL calculates as TODAY in IST"
      },
      summary: stats.rows[0],
      allocations: result.rows.map(r => ({
        bed: r.bed_number,
        name: r.name,
        dates: `${r.start_date_str} to ${r.end_date_str}`,
        status: r.status,
        backend_timeframe: r.backend_timeframe,
        backend_classification: r.backend_classification,
        expected_color: r.expected_frontend_color,
        deleted: r.deleted_at ? 'YES' : 'NO'
      }))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'debug_failed', message: e.message });
  }
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
// body: { name, phone, gender, startDate, endDate, aadharNumber, personPhotoKey, aadhaarPhotoKey }
app.post('/api/locations/:id/beds/:bedNumber/allocate', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const bedNumber = Number(req.params.bedNumber);
    await validateBedWithinCapacity(id, bedNumber);

    const { name, phone, gender, startDate, endDate, aadharNumber, personPhotoKey, aadhaarPhotoKey } = req.body || {};
    if (!name || !startDate || !endDate) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    // Validate photos are provided
    if (!personPhotoKey || !aadhaarPhotoKey) {
      return res.status(400).json({ error: 'photos_required', message: 'Both person and Aadhaar photos are required' });
    }

    // Validate and normalize gender
    const validGenders = ['Male', 'Female', 'Other'];
    const normalizedGender = gender && gender.trim() && validGenders.includes(gender.trim()) 
      ? gender.trim() 
      : 'Other';

    // Cleanup: soft-delete expired reservations on this bed
    try {
      await execQuery(`
        UPDATE allocations
        SET deleted_at = NOW(), updated_at = NOW()
        WHERE location_id = $1
          AND bed_number = $2
          AND status = 'reserved'
          AND deleted_at IS NULL
          AND (
            (reserved_expires_at IS NOT NULL AND reserved_expires_at <= NOW())
            OR end_date < ${todaySQL}
          )
      `, [id, bedNumber]);
    } catch {}

    // Check if bed has current or future allocation (end_date >= today)
    const checkQ = `
      SELECT id FROM allocations
      WHERE location_id = $1
        AND bed_number = $2
        AND deleted_at IS NULL
        AND end_date >= ${todaySQL}
        AND (status = 'confirmed' OR (status = 'reserved' AND reserved_expires_at > ${nowIST}))
      LIMIT 1
    `;
    const existing = await execQuery(checkQ, [id, bedNumber]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ 
        error: 'bed_already_allocated',
        message: 'This bed is already allocated or reserved (current or future booking exists)'
      });
    }

    // Insert allocation
    const q = `
      INSERT INTO allocations(location_id, bed_number, name, phone, gender, start_date, end_date, aadhar_number, person_photo_key, aadhaar_photo_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
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
      aadharNumber || null,
      personPhotoKey,
      aadhaarPhotoKey
    ]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[ALLOCATE ERROR]', {
      error: e.message,
      code: e.code,
      detail: e.detail,
      bedNumber,
      locationId: id,
      timestamp: new Date().toISOString()
    });
    // Exclusion constraint violation code is 23P01
    if (e.code === '23P01') {
      return res.status(409).json({ 
        error: 'overlapping_allocation',
        message: 'Cannot allocate: This bed is already booked for the selected dates',
        detail: e.detail
      });
    }
    res.status(500).json({ error: 'allocate_failed', message: e.message });
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
      SELECT id, name, phone, gender, 
             TO_CHAR(start_date, 'YYYY-MM-DD') as start_date,
             TO_CHAR(end_date, 'YYYY-MM-DD') as end_date
      FROM allocations
      WHERE location_id = $1
        AND bed_number = $2
        AND deleted_at IS NULL
        AND end_date >= ${todaySQL}
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
    const newStartDate = startDate !== undefined ? startDate : current.start_date;
    const newEndDate = endDate !== undefined ? endDate : current.end_date;

    // Cleanup: soft-delete expired reservations on this bed (only if not the current allocation)
    try {
      const cleanupResult = await execQuery(`
        UPDATE allocations
        SET deleted_at = NOW(), updated_at = NOW()
        WHERE location_id = $1
          AND bed_number = $2
          AND status = 'reserved'
          AND deleted_at IS NULL
          AND id != $3
          AND (
            (reserved_expires_at IS NOT NULL AND reserved_expires_at <= NOW())
            OR end_date < ${todaySQL}
          )
      `, [id, bedNumber, current.id]);
      if (cleanupResult.rowCount > 0) {
        console.log('[EDIT] Cleaned up', cleanupResult.rowCount, 'expired reservations before edit');
      }
    } catch (cleanupErr) {
      console.error('[EDIT] Cleanup error:', cleanupErr.message);
    }

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
    console.error('[EDIT ERROR]', {
      error: e.message,
      code: e.code,
      detail: e.detail,
      bedNumber,
      locationId: id,
      timestamp: new Date().toISOString()
    });
    if (e.code === '23P01') {
      return res.status(409).json({ 
        error: 'overlapping_allocation',
        message: 'Cannot update: The new dates conflict with an existing booking',
        detail: e.detail
      });
    }
    res.status(500).json({ error: 'edit_failed', message: e.message });
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
          AND end_date >= ${todaySQL}
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
    
    // Debug logging to help troubleshoot stats issues
    const debug = req.query.debug === 'true';
    if (debug && data.blocks && data.blocks.length > 0) {
      // For each block, get detailed allocation info
      for (const block of data.blocks) {
        const debugQuery = await execQuery(`
          SELECT 
            COUNT(*) FILTER (WHERE deleted_at IS NULL) as total_all,
            COUNT(*) FILTER (WHERE deleted_at IS NULL AND end_date >= ${todaySQL}) as total_current_future,
            COUNT(*) FILTER (WHERE deleted_at IS NULL AND end_date < ${todaySQL}) as total_past,
            COUNT(*) FILTER (WHERE deleted_at IS NULL AND status = 'confirmed') as total_confirmed_all,
            COUNT(*) FILTER (WHERE deleted_at IS NULL AND end_date >= ${todaySQL} AND status = 'confirmed') as total_confirmed_current,
            MIN(end_date) as earliest_end,
            MAX(end_date) as latest_end
          FROM blocks b
          JOIN allocations a ON a.block_id = b.id
          WHERE b.location_id = $1 
            AND (SELECT tent_id FROM blocks WHERE location_id = $1 AND block_index = $2 LIMIT 1) = b.tent_id
            AND b.block_index = $2
          GROUP BY b.id
        `, [req.params.id, block.index]);
        
        console.log(`[DEBUG BLOCK ${block.index}]`, {
          blockSize: block.size,
          reportedAllocated: block.allocated,
          ...debugQuery.rows[0],
          todayIST: getTodayIST()
        });
      }
    }
    
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
    WHERE block_id = $1 AND deleted_at IS NULL AND end_date >= ${todaySQL}
      AND (status = 'confirmed' OR (status = 'reserved' AND reserved_expires_at > NOW()))
  `, [blockId]);
  const occupied = new Set(occ.rows.map(r => r.bed_number));
  const free = [];
  for (let i = 1; i <= blockSize; i++) if (!occupied.has(i)) free.push(i);
  return free;
}

// POST /api/allocations/smart-reserve
// body: { phone, contactName?, isFamily, maleCount, femaleCount, startDate, endDate, confirmFallback?, aadharNumber? }
app.post('/api/allocations/smart-reserve', async (req, res) => {
  const { phone, contactName, isFamily, maleCount = 0, femaleCount = 0, startDate, endDate, confirmFallback = false, aadharNumber } = req.body || {};
  
  try {
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

    // Clean up expired reservations first to avoid conflicts with stale data
    try {
      const cleanupResult = await execQuery(`
        UPDATE allocations
        SET deleted_at = NOW(), updated_at = NOW()
        WHERE deleted_at IS NULL
          AND status = 'reserved'
          AND (
            (reserved_expires_at IS NOT NULL AND reserved_expires_at <= NOW())
            OR end_date < ${todaySQL}
          )
      `);
      if (cleanupResult.rowCount > 0) {
        console.log('[SMART-RESERVE] Cleaned up', cleanupResult.rowCount, 'expired reservations before processing');
      }
    } catch (cleanupErr) {
      console.error('[SMART-RESERVE] Cleanup error:', cleanupErr.message);
      // Continue anyway - cleanup failure shouldn't block the reservation
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

    // Prefetch occupancy for all blocks - check current + future allocations (end_date >= today)
    console.log('[SMART-RESERVE] Checking current and future allocations');
    const occRes = await execQuery(`
      SELECT block_id, bed_number, start_date, end_date, status, reserved_expires_at, id, phone
      FROM allocations
      WHERE deleted_at IS NULL
        AND end_date >= ${todaySQL}
        AND (status = 'confirmed' OR (status = 'reserved' AND reserved_expires_at > NOW()))
    `);
    console.log('[SMART-RESERVE] Found', occRes.rows.length, 'total active allocations across all blocks');
    
    // Log detailed occupancy per block for debugging
    const blockOccupancyCounts = new Map();
    occRes.rows.forEach(r => {
      const count = blockOccupancyCounts.get(r.block_id) || 0;
      blockOccupancyCounts.set(r.block_id, count + 1);
    });
    console.log('[SMART-RESERVE] Block occupancy counts:', Array.from(blockOccupancyCounts.entries()).map(([bid, count]) => `Block ${bid}: ${count} beds occupied`).join(', '));
    
    const occupiedByBlock = new Map(); // block_id -> Set of occupied beds
    const occupancyDetails = new Map(); // For debugging - track what's occupying each bed
    for (const r of occRes.rows) {
      const bid = Number(r.block_id);
      const bedNum = Number(r.bed_number);
      const set = occupiedByBlock.get(bid) || new Set();
      set.add(bedNum);
      occupiedByBlock.set(bid, set);
      
      // Store details for debugging
      const key = `${bid}-${bedNum}`;
      if (!occupancyDetails.has(key)) {
        occupancyDetails.set(key, []);
      }
      occupancyDetails.get(key).push({
        id: r.id,
        phone: r.phone,
        startDate: r.start_date,
        endDate: r.end_date,
        status: r.status,
        expiresAt: r.reserved_expires_at
      });
    }
    const freeBedsByBlock = new Map(); // block_id -> Array of free beds (ascending)
    for (const b of blockRes.rows) {
      const occ = occupiedByBlock.get(b.id) || new Set();
      const arr = [];
      for (let i = 1; i <= Number(b.size); i++) if (!occ.has(i)) arr.push(i);
      freeBedsByBlock.set(b.id, arr);
      console.log(`[SMART-RESERVE] Block ${b.id} (L${b.location_id} T${b.tent_index} B${b.block_index}): ${b.size} total, ${occ.size} occupied, ${arr.length} free`);
    }

    let finalPlan = null;

    if (isFamily) {
      // FAMILY ALLOCATION STRATEGY:
      // Priority 1: Maximize male-female pairs in 'both' blocks (same block = together)
      // Priority 2: Same location/tent is secondary consideration
      // Priority 3: If not enough 'both' blocks, use single-gender blocks for excess
      
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
      
      // Get all 'both' blocks sorted by capacity (largest first for better pair allocation)
      const blocksMixed = blockRes.rows
        .filter(b => b.gender_restriction === 'both')
        .map(b => ({
          ...b,
          freeCapacity: (freeBedsByBlock.get(b.id) || []).length
        }))
        .filter(b => b.freeCapacity > 0)
        .sort((a, b) => {
          // Sort by capacity descending, then by location/tent/block
          if (b.freeCapacity !== a.freeCapacity) return b.freeCapacity - a.freeCapacity;
          if (a.location_id !== b.location_id) return a.location_id - b.location_id;
          if (a.tent_index !== b.tent_index) return a.tent_index - b.tent_index;
          return a.block_index - b.block_index;
        });
      
      const totalMixedCapacity = blocksMixed.reduce((sum, b) => sum + b.freeCapacity, 0);
      
      // Calculate how many pairs we can allocate (1 male + 1 female = pair)
      const pairsNeeded = Math.min(malesRem, femalesRem);
      const pairsWeCanAllocate = Math.min(pairsNeeded, Math.floor(totalMixedCapacity / 2));
      
      console.log('[FAMILY ALLOC] Males:', malesRem, 'Females:', femalesRem, 'Pairs needed:', pairsNeeded);
      console.log('[FAMILY ALLOC] Total mixed capacity:', totalMixedCapacity, 'Pairs we can allocate:', pairsWeCanAllocate);
      console.log('[FAMILY ALLOC] Mixed blocks:', blocksMixed.map(b => 
        `L${b.location_id}T${b.tent_index}B${b.block_index}:${b.freeCapacity}beds`
      ).join(', '));
      
      // STEP 1: Allocate pairs to 'both' blocks (maximize togetherness)
      let pairsAllocated = 0;
      for (const b of blocksMixed) {
        if (pairsAllocated >= pairsWeCanAllocate) break;
        
        const pairsRemainingToAllocate = pairsWeCanAllocate - pairsAllocated;
        const pairsThisBlockCanFit = Math.floor(b.freeCapacity / 2);
        const pairsToAllocateHere = Math.min(pairsRemainingToAllocate, pairsThisBlockCanFit);
        
        if (pairsToAllocateHere > 0) {
          console.log(`[FAMILY ALLOC] Block L${b.location_id}T${b.tent_index}B${b.block_index}: allocating ${pairsToAllocateHere} pairs`);
          for (let i = 0; i < pairsToAllocateHere; i++) {
            reserveGlobal(b, 1, 'Male');
            reserveGlobal(b, 1, 'Female');
          }
          pairsAllocated += pairsToAllocateHere;
          malesRem -= pairsToAllocateHere;
          femalesRem -= pairsToAllocateHere;
        }
      }
      
      console.log('[FAMILY ALLOC] After pair allocation - Males rem:', malesRem, 'Females rem:', femalesRem);
      
      // STEP 2: Use remaining capacity in 'both' blocks for individuals (alternate to maintain balance)
      for (const b of blocksMixed) {
        if (malesRem <= 0 && femalesRem <= 0) break;
        
        const freeInBlock = (freeBedsByBlock.get(b.id) || []).length;
        if (freeInBlock === 0) continue;
        
        // Alternate between male and female when both remain
        while ((freeBedsByBlock.get(b.id) || []).length > 0 && (malesRem > 0 || femalesRem > 0)) {
          if (malesRem > 0 && femalesRem > 0) {
            // Allocate whichever has more remaining to maintain balance
            if (malesRem >= femalesRem) {
              reserveGlobal(b, 1, 'Male');
              malesRem -= 1;
            } else {
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
      
      console.log('[FAMILY ALLOC] After using remaining mixed blocks - Males rem:', malesRem, 'Females rem:', femalesRem);
      
      // STEP 3: If we still have remaining people, use single-gender blocks
      if (malesRem > 0 || femalesRem > 0) {
        if (!confirmFallback) {
          return res.status(409).json({
            error: 'requires_confirmation',
            requiresConfirmation: 'need-single-gender-blocks',
            message: `All-gender blocks are full. ${malesRem > 0 ? `${malesRem} male${malesRem > 1 ? 's' : ''}` : ''}${malesRem > 0 && femalesRem > 0 ? ' and ' : ''}${femalesRem > 0 ? `${femalesRem} female${femalesRem > 1 ? 's' : ''}` : ''} will be allocated to single-gender blocks. Continue?`,
            preview: planItems.map(i => ({ locationId: i.locationId, tentIndex: i.tentIndex, blockIndex: i.blockIndex, bedNumber: i.bedNumber, gender: i.gender }))
          });
        }
        
        // Allocate remaining males to male_only blocks
        if (malesRem > 0) {
          const maleBlocks = blockRes.rows
            .filter(b => b.gender_restriction === 'male_only')
            .sort((a,b) => a.location_id - b.location_id || a.tent_index - b.tent_index || a.block_index - b.block_index);
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
            .sort((a,b) => a.location_id - b.location_id || a.tent_index - b.tent_index || a.block_index - b.block_index);
          for (const b of femaleBlocks) {
            if (femalesRem <= 0) break;
            const got = reserveGlobal(b, femalesRem, 'Female');
            femalesRem -= got;
          }
        }
      }
      
      if (malesRem <= 0 && femalesRem <= 0) {
        finalPlan = { items: planItems, requiresConfirmation: pairsAllocated < pairsNeeded ? 'split' : null };
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
      console.log('[SMART-RESERVE] Insufficient beds - no plan found', {
        totalCount,
        maleCount,
        femaleCount,
        isFamily,
        dateRange: `${startDate} to ${endDate}`,
        requestedTotal: totalCount,
        totalFreeBeds: Array.from(freeBedsByBlock.values()).reduce((sum, arr) => sum + arr.length, 0),
        freeByGenderRestriction: {
          both: blockRes.rows.filter(b => b.gender_restriction === 'both').reduce((sum, b) => sum + (freeBedsByBlock.get(b.id) || []).length, 0),
          male_only: blockRes.rows.filter(b => b.gender_restriction === 'male_only').reduce((sum, b) => sum + (freeBedsByBlock.get(b.id) || []).length, 0),
          female_only: blockRes.rows.filter(b => b.gender_restriction === 'female_only').reduce((sum, b) => sum + (freeBedsByBlock.get(b.id) || []).length, 0),
        },
        timestamp: new Date().toISOString()
      });
      return res.status(400).json({ error: 'insufficient_beds', message: 'Unable to satisfy reservation with current capacity' });
    }
    
    // Log the final plan before attempting insertion
    console.log('[SMART-RESERVE] Final plan ready:', {
      batchId: `batch_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
      totalBeds: finalPlan.items.length,
      locations: [...new Set(finalPlan.items.map(i => i.locationId))],
      dateRange: `${startDate} to ${endDate}`,
      phone,
      contactName,
      isFamily,
      maleCount,
      femaleCount,
      timestamp: new Date().toISOString()
    });
    
    // Group plan by block to show what's being allocated where
    const planByBlock = new Map();
    finalPlan.items.forEach(item => {
      const key = `${item.locationId}-${item.tentIndex}-${item.blockIndex}`;
      if (!planByBlock.has(key)) {
        planByBlock.set(key, { males: 0, females: 0, beds: [] });
      }
      const entry = planByBlock.get(key);
      if (item.gender === 'Male') entry.males++;
      else if (item.gender === 'Female') entry.females++;
      entry.beds.push(item.bedNumber);
    });
    console.log('[SMART-RESERVE] Allocation plan by block:');
    planByBlock.forEach((stats, key) => {
      const [loc, tent, block] = key.split('-');
      console.log(`  L${loc} T${tent} B${block}: ${stats.males}M + ${stats.females}F = ${stats.beds.length} beds (bed numbers: ${stats.beds.slice(0, 5).join(', ')}${stats.beds.length > 5 ? '...' : ''})`);
    });

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
      const cols = `location_id, tent_id, block_id, tent_index, block_index, bed_number, name, phone, gender, start_date, end_date, status, batch_id, contact_name, is_family, reserved_expires_at, aadhar_number`;
      
      // Batch insert to avoid parameter limit (PostgreSQL limit is ~65535 params)
      const batchSize = 500; // 500 rows * 16 params = 8000 params per batch (safe)
      for (let i = 0; i < finalPlan.items.length; i += batchSize) {
        const chunk = finalPlan.items.slice(i, i + batchSize);
        const values = [];
        const params = [];
        let p = 1;
        
        for (const item of chunk) {
          values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},'reserved',$${p++},$${p++},$${p++},$${p++},$${p++})`);
          params.push(
            item.locationId, item.tentId, item.blockId, item.tentIndex, item.blockIndex, item.bedNumber,
            contactName || 'Reserved', phone, item.gender, startDate, endDate,
            batchId, contactName || null, !!isFamily, expiresAt, aadharNumber || null
          );
        }
        
        const sql = `INSERT INTO allocations(${cols}) VALUES ${values.join(',')}`;
        await execQuery(sql, params);
      }
      
      await execQuery('COMMIT');
    } catch (e) {
      await execQuery('ROLLBACK');
      if (e.code === '23P01') {
        // Exclusion constraint violation - provide detailed error
        console.error('[SMART-RESERVE CONFLICT]', {
          batchId,
          error: e.message,
          detail: e.detail,
          itemsAttempted: finalPlan.items.length,
          dateRange: `${startDate} to ${endDate}`,
          maleCount,
          femaleCount,
          isFamily,
          timestamp: new Date().toISOString()
        });
        return res.status(409).json({ 
          error: 'overlapping_allocation',
          message: 'One or more beds are already booked for the requested dates. The beds may have been reserved by someone else while you were completing your booking.',
          detail: e.detail || 'Date range conflict detected'
        });
      }
      throw e;
    }

    // Determine if a single location or multiple were used
    const locSet = new Set(finalPlan.items.map(i=>i.locationId));
    const singleLocationId = locSet.size === 1 ? finalPlan.items[0].locationId : null;

    await logAudit(req, 'smart_reserve', 'reservation', null, { batchId, phone, contactName, isFamily, maleCount, femaleCount, totalBeds: finalPlan.items.length, startDate, endDate, locations: Array.from(locSet) });

    return res.json({
      ok: true,
      batchId,
      locationId: singleLocationId,
      items: finalPlan.items.map(i=>({ locationId: i.locationId, tentIndex: i.tentIndex, blockIndex: i.blockIndex, bedNumber: i.bedNumber, gender: i.gender }))
    });
  } catch (e) {
    console.error('[SMART-RESERVE ERROR]', {
      error: e.message,
      code: e.code,
      stack: e.stack,
      requestBody: { phone, isFamily, maleCount, femaleCount, startDate, endDate },
      timestamp: new Date().toISOString()
    });
    res.status(500).json({ 
      error: 'smart_reserve_failed', 
      message: e.message || 'Failed to process reservation request',
      detail: e.detail || null
    });
  }
});

// GET /api/allocations/by-phone/:phone - Search allocations by phone number (MUST be before query-based route)
app.get('/api/allocations/by-phone/:phone', async (req, res) => {
  console.log('HIT: /api/allocations/by-phone/:phone with phone =', req.params.phone);
  try {
    const user = getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { phone } = req.params;

    const result = await execQuery(`
      SELECT 
        a.id,
        a.location_id,
        a.tent_id,
        a.block_id,
        a.tent_index,
        a.block_index,
        a.bed_number,
        a.name,
        a.phone,
        a.aadhar_number,
        a.gender,
        TO_CHAR(a.start_date, 'YYYY-MM-DD') as start_date,
        TO_CHAR(a.end_date, 'YYYY-MM-DD') as end_date,
        a.status,
        a.person_photo_key,
        a.aadhaar_photo_key,
        TO_CHAR(a.created_at, 'YYYY-MM-DD HH24:MI:SS') as created_at,
        l.name as location_name
      FROM allocations a
      JOIN locations l ON l.id = a.location_id
      WHERE a.phone = $1 
        AND a.deleted_at IS NULL
      ORDER BY a.created_at DESC
    `, [phone]);

    // Generate pre-signed URLs for photos
    const allocations = await Promise.all(
      result.rows.map(async (row) => {
        const personPhotoUrl = row.person_photo_key 
          ? await generateViewUrl(row.person_photo_key) 
          : null;
        const aadhaarPhotoUrl = row.aadhaar_photo_key 
          ? await generateViewUrl(row.aadhaar_photo_key) 
          : null;

        return {
          ...row,
          personPhotoUrl,
          aadhaarPhotoUrl
        };
      })
    );

    res.json(allocations);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'search_failed' });
  }
});

// GET /api/allocations/by-phone?phone=...
app.get('/api/allocations/by-phone', async (req, res) => {
  try {
    const phone = String(req.query.phone || '').trim();
    if (!phone) return res.status(400).json({ error: 'missing_phone' });
    const user = getUserFromRequest(req);
    if (!user || !['admin', 'location_user'].includes(user.role)) return res.status(403).json({ error: 'forbidden' });

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
    if (!user || !['admin', 'location_user'].includes(user.role)) return res.status(403).json({ error: 'forbidden' });
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
    await logAudit(req, 'update_phone', 'allocation', null, { oldPhone, newPhone, batchId, allocationIds, updated: r.rowCount });
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
    if (!user || !['admin', 'location_user'].includes(user.role)) return res.status(403).json({ error: 'forbidden' });
    const { phone, contactName, batchId } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'missing_phone' });

    const params = [contactName || null, phone];
    let q = `UPDATE allocations SET contact_name = $1, updated_at = NOW() WHERE phone = $2 AND deleted_at IS NULL`;
    if (batchId) { q += ` AND batch_id = $3`; params.push(batchId); }

    const r = await execQuery(q, params);
    await logAudit(req, 'update_contact', 'allocation', null, { phone, contactName, batchId, updated: r.rowCount });
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
    if (!user || !['admin', 'location_user'].includes(user.role)) return res.status(403).json({ error: 'forbidden' });
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
    await logAudit(req, 'update_end_date', 'allocation', null, { phone, endDate, batchId, allocationIds, updated: r.rowCount });
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
    if (!user || !['admin', 'location_user'].includes(user.role)) return res.status(403).json({ error: 'forbidden' });
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
    if (!user || !['admin', 'location_user'].includes(user.role)) return res.status(403).json({ error: 'forbidden' });
    const date = String(req.query.date || '').trim();
    if (!date) return res.status(400).json({ error: 'missing_date' });

    const rows = await execQuery(`
      SELECT a.id, a.phone, a.contact_name, a.location_id, l.name as location_name, a.tent_index, a.block_index, a.bed_number, a.gender, a.status, a.start_date, a.end_date
      FROM allocations a
      LEFT JOIN locations l ON a.location_id = l.id
      WHERE a.deleted_at IS NULL AND a.end_date = $1
      ORDER BY a.location_id, a.tent_index, a.block_index, a.bed_number
    `, [date]);
    await logAudit(req, 'download_departures', 'report', null, { date, count: rows.rows.length });
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
    if (!user || !['admin', 'location_user'].includes(user.role)) return res.status(403).json({ error: 'forbidden' });
    const rows = await execQuery(`
      SELECT a.id, a.batch_id, a.phone, a.contact_name, a.location_id, l.name as location_name, a.tent_index, a.block_index, a.bed_number, 
             a.reserved_expires_at, a.start_date, a.end_date, a.gender
      FROM allocations a
      LEFT JOIN locations l ON a.location_id = l.id
      WHERE a.deleted_at IS NULL AND a.status = 'reserved' AND (a.reserved_expires_at IS NULL OR a.reserved_expires_at > NOW())
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
    if (!user || !['admin', 'location_user'].includes(user.role)) return res.status(403).json({ error: 'forbidden' });
    const { batchId, allocationIds } = req.body || {};
    if (!batchId) return res.status(400).json({ error: 'missing_batch' });

    await execQuery('BEGIN');
    try {
      // Select target rows (reserved and not expired)
      const target = await execQuery(`
        SELECT id FROM allocations
        WHERE batch_id = $1 AND status = 'reserved' AND (reserved_expires_at IS NULL OR reserved_expires_at > NOW())
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
      await logAudit(req, 'confirm', 'reservation', null, { batchId, confirmedCount: ids.length, allocationIds: ids });
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
        AND (
          (reserved_expires_at IS NOT NULL AND reserved_expires_at <= NOW())
          OR end_date < ${todaySQL}
        )
    `);

    res.json({ ok: true, cleaned: result.rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'cleanup_expired_failed' });
  }
});

// POST /api/upload-url - Generate pre-signed URL for photo upload
app.post('/api/upload-url', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { photoType, locationId, tentIndex, blockIndex, key } = req.body;
    
    if (!photoType || !locationId) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    if (photoType !== 'person' && photoType !== 'aadhaar') {
      return res.status(400).json({ error: 'invalid_photo_type' });
    }

    // If frontend provides key, use it; otherwise generate one
    const photoKey = key || (() => {
      const timestamp = Date.now();
      const uuid = crypto.randomUUID();
      return `location-${locationId}/tent-${tentIndex || 0}/block-${blockIndex || 0}/${timestamp}-${uuid}-${photoType}.jpg`;
    })();

    const { uploadUrl } = await generateUploadUrl(
      photoType,
      Number(locationId),
      Number(tentIndex || 0),
      Number(blockIndex || 0),
      photoKey // Pass the key to use
    );

    res.json({ uploadUrl, key: photoKey });
  } catch (e) {
    console.error('Error in /api/upload-url:', e);
    res.status(500).json({ error: 'generate_upload_url_failed' });
  }
});

// POST /api/photo-view-url - Generate pre-signed view URL for a photo
app.post('/api/photo-view-url', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { key } = req.body;
    
    if (!key) {
      return res.status(400).json({ error: 'missing_key' });
    }

    const viewUrl = await generateViewUrl(key);
    res.json({ viewUrl });
  } catch (e) {
    console.error('Error in /api/photo-view-url:', e);
    res.status(500).json({ error: 'generate_view_url_failed' });
  }
});

// PATCH /api/allocations/:id - Update allocation
app.patch('/api/allocations/:id', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { id } = req.params;
    const { name, phone, aadharNumber, gender, startDate, endDate, personPhotoKey, aadhaarPhotoKey } = req.body;

    // Validate allocation exists and is not deleted
    const existing = await execQuery(
      'SELECT * FROM allocations WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (existing.rowCount === 0) {
      return res.status(404).json({ error: 'allocation_not_found' });
    }

    const current = existing.rows[0];

    // Build update query dynamically based on provided fields
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (phone !== undefined) {
      updates.push(`phone = $${paramIndex++}`);
      values.push(phone);
    }
    if (aadharNumber !== undefined) {
      updates.push(`aadhar_number = $${paramIndex++}`);
      values.push(aadharNumber || null);
    }
    if (gender !== undefined) {
      updates.push(`gender = $${paramIndex++}`);
      values.push(gender);
    }
    if (startDate !== undefined) {
      updates.push(`start_date = $${paramIndex++}`);
      values.push(startDate);
    }
    if (endDate !== undefined) {
      updates.push(`end_date = $${paramIndex++}`);
      values.push(endDate);
    }
    if (personPhotoKey !== undefined) {
      updates.push(`person_photo_key = $${paramIndex++}`);
      values.push(personPhotoKey);
    }
    if (aadhaarPhotoKey !== undefined) {
      updates.push(`aadhaar_photo_key = $${paramIndex++}`);
      values.push(aadhaarPhotoKey);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'no_fields_to_update' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    const query = `
      UPDATE allocations 
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result = await execQuery(query, values);

    await logAudit(req, 'update', 'allocation', id, { 
      updated_fields: Object.keys(req.body),
      bed_number: current.bed_number 
    });

    res.json({ ok: true, allocation: result.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'update_failed' });
  }
});

// POST /api/locations/:id/tents/:tent/blocks/:block/beds/:bedNumber/allocate
app.post('/api/locations/:id/tents/:tent/blocks/:block/beds/:bedNumber/allocate', async (req, res) => {
  const startTime = Date.now();
  try {
    const locationId = Number(req.params.id);
    const tentIndex = Number(req.params.tent);
    const blockIndex = Number(req.params.block);
    const bedNumber = Number(req.params.bedNumber);
    
    console.log(`[ALLOCATE] Start - Bed ${bedNumber}`);

    const { name, phone, gender, startDate, endDate, aadharNumber, personPhotoKey, aadhaarPhotoKey } = req.body || {};
    if (!name || !startDate || !endDate) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    // Validate photos are provided
    if (!personPhotoKey || !aadhaarPhotoKey) {
      return res.status(400).json({ error: 'photos_required', message: 'Both person and Aadhaar photos are required' });
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

    // Combined validation - gets blockId, tentId and validates bed + gender in ONE query
    const t1 = Date.now();
    let blockId, tentId;
    try {
      const result = await validateAndGetBlockInfo(locationId, tentIndex, blockIndex, bedNumber, normalizedGender);
      blockId = result.blockId;
      tentId = result.tentId;
    } catch (e) {
      return res.status(400).json({ error: 'validation_failed', message: e.message });
    }
    console.log(`[ALLOCATE] Combined validation: ${Date.now() - t1}ms`);

    // Cleanup: soft-delete expired reservations on this bed (non-blocking)
    const t2 = Date.now();
    execQuery(`
      UPDATE allocations
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE block_id = $1
        AND bed_number = $2
        AND status = 'reserved'
        AND deleted_at IS NULL
        AND (
          (reserved_expires_at IS NOT NULL AND reserved_expires_at <= NOW())
          OR end_date < ${todaySQL}
        )
    `, [blockId, bedNumber]).catch(() => {}); // Non-blocking, ignore errors
    console.log(`[ALLOCATE] Cleanup (non-blocking): ${Date.now() - t2}ms`);

    // Check if bed has current or future allocation (end_date >= today)
    const t3 = Date.now();
    const checkQ = `
      SELECT id FROM allocations
      WHERE block_id = $1
        AND bed_number = $2
        AND deleted_at IS NULL
        AND end_date >= ${todaySQL}
        AND (status = 'confirmed' OR (status = 'reserved' AND reserved_expires_at > ${nowIST}))
      LIMIT 1
    `;
    const existing = await execQuery(checkQ, [blockId, bedNumber]);
    console.log(`[ALLOCATE] Check existing: ${Date.now() - t3}ms`);
    if (existing.rowCount > 0) {
      return res.status(409).json({ 
        error: 'bed_already_allocated',
        message: 'This bed is already allocated or reserved (current or future booking exists)'
      });
    }

    const t4 = Date.now();
    // Combine INSERT + fetch using RETURNING clause (saves 1 round-trip!)
    const q = `
      INSERT INTO allocations(location_id, tent_id, block_id, tent_index, block_index, bed_number, name, phone, gender, start_date, end_date, aadhar_number, person_photo_key, aadhaar_photo_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING id, name, phone, gender,
                TO_CHAR(start_date, 'YYYY-MM-DD') as start_date,
                TO_CHAR(end_date, 'YYYY-MM-DD') as end_date,
                aadhar_number, person_photo_key, aadhaar_photo_key, status
    `;
    const insertResult = await execQuery(q, [
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
      aadharNumber || null,
      personPhotoKey,
      aadhaarPhotoKey
    ]);
    const allocation = insertResult.rows[0];
    const allocationId = allocation.id;
    console.log(`[ALLOCATE] INSERT+fetch: ${Date.now() - t4}ms`);
    
    // Log audit in background (non-blocking - saves 300ms!)
    logAudit(req, 'allocate', 'allocation', allocationId, { locationId, tentIndex, blockIndex, bedNumber, name, phone, gender: normalizedGender, startDate, endDate });

    // Transform to camelCase (no need to generate view URLs - frontend already has the photos)
    const result = {
      id: allocation.id,
      name: allocation.name,
      phone: allocation.phone,
      gender: allocation.gender,
      startDate: allocation.start_date,
      endDate: allocation.end_date,
      aadharNumber: allocation.aadhar_number,
      status: allocation.status,
      personPhotoKey: allocation.person_photo_key,
      aadhaarPhotoKey: allocation.aadhaar_photo_key
    };

    console.log(`[ALLOCATE] Total time: ${Date.now() - startTime}ms`);
    res.json(result);
  } catch (e) {
    console.error('[ALLOCATE-BLOCK ERROR]', {
      error: e.message,
      code: e.code,
      detail: e.detail,
      bedNumber,
      locationId,
      tentIndex,
      blockIndex,
      timestamp: new Date().toISOString()
    });
    if (e.code === '23P01') {
      return res.status(409).json({ 
        error: 'overlapping_allocation',
        message: 'Cannot allocate: This bed is already booked for the selected dates',
        detail: e.detail
      });
    }
    res.status(500).json({ error: 'allocate_failed', message: e.message });
  }
});

// POST /api/locations/:id/tents/:tent/blocks/:block/beds/bulk-allocate
app.post('/api/locations/:id/tents/:tent/blocks/:block/beds/bulk-allocate', async (req, res) => {
  try {
    const locationId = Number(req.params.id);
    const tentIndex = Number(req.params.tent);
    const blockIndex = Number(req.params.block);
    
    const { name, phone, maleCount, femaleCount, startDate, endDate, aadharNumber } = req.body || {};
    
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

    // Cleanup: soft-delete expired reservations in this block for the date range
    try {
      const cleanupResult = await execQuery(`
        UPDATE allocations
        SET deleted_at = NOW(), updated_at = NOW()
        WHERE block_id = $1
          AND status = 'reserved'
          AND deleted_at IS NULL
          AND (
            (reserved_expires_at IS NOT NULL AND reserved_expires_at <= NOW())
            OR end_date < ${todaySQL}
          )
      `, [blockId]);
      if (cleanupResult.rowCount > 0) {
        console.log('[BULK-ALLOCATE] Cleaned up', cleanupResult.rowCount, 'expired reservations');
      }
    } catch (cleanupErr) {
      console.error('[BULK-ALLOCATE] Cleanup error:', cleanupErr.message);
    }

    // Find available beds in this block (beds with active allocations are unavailable)
    const occupiedRes = await execQuery(`
      SELECT DISTINCT bed_number 
      FROM allocations 
      WHERE block_id = $1 
        AND deleted_at IS NULL
        AND end_date >= ${todaySQL}
    `, [blockId]);
    
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

    // Generate a batch ID for this bulk allocation
    const batchId = `batch_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const success = [];
    const errors = [];
    
    try {
      // Validate gender restrictions before allocating
      if (maleCount > 0) {
        await validateGenderRestriction(locationId, tentIndex, blockIndex, 'Male');
      }
      if (femaleCount > 0) {
        await validateGenderRestriction(locationId, tentIndex, blockIndex, 'Female');
      }

      // Build bulk insert values
      const values = [];
      const placeholders = [];
      let paramIndex = 1;
      let bedIndex = 0;

      // Prepare male allocations
      for (let i = 0; i < (maleCount || 0); i++) {
        const bedNumber = availableBeds[bedIndex++];
        placeholders.push(`($${paramIndex},$${paramIndex+1},$${paramIndex+2},$${paramIndex+3},$${paramIndex+4},$${paramIndex+5},$${paramIndex+6},$${paramIndex+7},$${paramIndex+8},$${paramIndex+9},$${paramIndex+10},$${paramIndex+11},$${paramIndex+12})`);
        values.push(locationId, tentId, blockId, tentIndex, blockIndex, bedNumber, name, phone || null, 'Male', startDate, endDate, batchId, aadharNumber || null);
        paramIndex += 13;
        success.push({ bedNumber, gender: 'Male', name });
      }

      // Prepare female allocations
      for (let i = 0; i < (femaleCount || 0); i++) {
        const bedNumber = availableBeds[bedIndex++];
        placeholders.push(`($${paramIndex},$${paramIndex+1},$${paramIndex+2},$${paramIndex+3},$${paramIndex+4},$${paramIndex+5},$${paramIndex+6},$${paramIndex+7},$${paramIndex+8},$${paramIndex+9},$${paramIndex+10},$${paramIndex+11},$${paramIndex+12})`);
        values.push(locationId, tentId, blockId, tentIndex, blockIndex, bedNumber, name, phone || null, 'Female', startDate, endDate, batchId, aadharNumber || null);
        paramIndex += 13;
        success.push({ bedNumber, gender: 'Female', name });
      }

      // Execute single bulk INSERT if we have any beds to allocate
      if (placeholders.length > 0) {
        await execQuery(`
          INSERT INTO allocations(location_id, tent_id, block_id, tent_index, block_index, bed_number, name, phone, gender, start_date, end_date, batch_id, aadhar_number)
          VALUES ${placeholders.join(', ')}
        `, values);
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
// body: partial { name, phone, gender, startDate, endDate, personPhotoKey, aadhaarPhotoKey }
// soft deletes current allocation and creates new one (preserves history)
app.patch('/api/locations/:id/tents/:tent/blocks/:block/beds/:bedNumber', async (req, res) => {
  const startTime = Date.now();
  try {
    const locationId = Number(req.params.id);
    const tentIndex = Number(req.params.tent);
    const blockIndex = Number(req.params.block);
    const bedNumber = Number(req.params.bedNumber);
    if (!Number.isFinite(bedNumber)) return res.status(400).json({ error: 'invalid_bed_number' });
    
    console.log(`[EDIT] Start - Bed ${bedNumber}`);
    
    // Combined validation - gets blockId, tentId in one query
    const t1 = Date.now();
    let blockId, tentId;
    try {
      const result = await validateAndGetBlockInfo(locationId, tentIndex, blockIndex, bedNumber, null);
      blockId = result.blockId;
      tentId = result.tentId;
    } catch (e) {
      return res.status(400).json({ error: 'validation_failed', message: e.message });
    }
    console.log(`[EDIT] Validation: ${Date.now() - t1}ms`);

    // Find current active allocation
    const t2 = Date.now();
    const findQ = `
      SELECT id, name, phone, gender, 
             TO_CHAR(start_date, 'YYYY-MM-DD') as start_date,
             TO_CHAR(end_date, 'YYYY-MM-DD') as end_date,
             person_photo_key, aadhaar_photo_key
      FROM allocations
      WHERE block_id = $1
        AND bed_number = $2
        AND deleted_at IS NULL
        AND end_date >= ${todaySQL}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const active = await execQuery(findQ, [blockId, bedNumber]);
    console.log(`[EDIT] Find active: ${Date.now() - t2}ms`);
    if (!active.rowCount) return res.status(404).json({ error: 'no_active_allocation' });

    const current = active.rows[0];
    const { name, phone, gender, startDate, endDate, personPhotoKey, aadhaarPhotoKey } = req.body || {};

    // Use current values as defaults for missing fields
    const newName = name !== undefined ? name : current.name;
    const newPhone = phone !== undefined ? phone : current.phone;
    const newGender = gender !== undefined ? (
      gender && gender.trim() && ['Male', 'Female', 'Other'].includes(gender.trim()) 
        ? gender.trim() 
        : 'Other'
    ) : current.gender;
    const newStartDate = startDate !== undefined ? startDate : current.start_date;
    const newEndDate = endDate !== undefined ? endDate : current.end_date;
    const newPersonPhotoKey = personPhotoKey !== undefined ? personPhotoKey : current.person_photo_key;
    const newAadhaarPhotoKey = aadhaarPhotoKey !== undefined ? aadhaarPhotoKey : current.aadhaar_photo_key;

    // Validate gender restriction for the block if gender is being changed
    if (gender !== undefined && gender !== current.gender) {
      const t2b = Date.now();
      try {
        await validateGenderRestriction(locationId, tentIndex, blockIndex, newGender);
      } catch (e) {
        return res.status(400).json({ error: 'gender_restriction_violation', message: e.message });
      }
      console.log(`[EDIT] Gender validation: ${Date.now() - t2b}ms`);
    }

    // Cleanup expired reservations (non-blocking)
    const t2c = Date.now();
    execQuery(`
      UPDATE allocations
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE block_id = $1
        AND bed_number = $2
        AND status = 'reserved'
        AND deleted_at IS NULL
        AND id != $3
        AND (
          (reserved_expires_at IS NOT NULL AND reserved_expires_at <= NOW())
          OR end_date < ${todaySQL}
        )
    `, [blockId, bedNumber, current.id]).catch(() => {});
    console.log(`[EDIT] Cleanup (non-blocking): ${Date.now() - t2c}ms`);

    // Soft delete old allocation first
    const t3 = Date.now();
    await execQuery(`
      UPDATE allocations 
      SET deleted_at = NOW() 
      WHERE id = $1
    `, [current.id]);
    console.log(`[EDIT] Delete old: ${Date.now() - t3}ms`);

    // Create new allocation with RETURNING
    const t4 = Date.now();
    const insertQ = `
      INSERT INTO allocations(
        location_id, tent_id, block_id, tent_index, block_index, bed_number, 
        name, phone, gender, start_date, end_date, 
        person_photo_key, aadhaar_photo_key
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id, name, phone, gender,
                TO_CHAR(start_date, 'YYYY-MM-DD') as start_date,
                TO_CHAR(end_date, 'YYYY-MM-DD') as end_date,
                person_photo_key, aadhaar_photo_key, status
    `;
    
    const result = await execQuery(insertQ, [
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
      newEndDate,
      newPersonPhotoKey,
      newAadhaarPhotoKey
    ]);
    
    const updatedAllocation = result.rows[0];
    const newAllocationId = updatedAllocation.id;
    console.log(`[EDIT] INSERT: ${Date.now() - t4}ms`);
    console.log(`[EDIT] Total DB time (delete+insert): ${Date.now() - t3}ms`);

    // Log audit in background (non-blocking)
    logAudit(req, 'edit_allocation', 'allocation', newAllocationId, { 
      locationId, tentIndex, blockIndex, bedNumber, 
      oldAllocationId: current.id,
      changes: { name, phone, gender, startDate, endDate }
    });

    // Return keys only (frontend generates view URLs)
    const response = {
      id: updatedAllocation.id,
      name: updatedAllocation.name,
      phone: updatedAllocation.phone,
      gender: updatedAllocation.gender,
      startDate: updatedAllocation.start_date,
      endDate: updatedAllocation.end_date,
      status: updatedAllocation.status,
      personPhotoKey: updatedAllocation.person_photo_key,
      aadhaarPhotoKey: updatedAllocation.aadhaar_photo_key
    };

    console.log(`[EDIT] Total time: ${Date.now() - startTime}ms`);
    res.json(response);
  } catch (e) {
    console.error('[EDIT ERROR]', {
      error: e.message,
      code: e.code,
      detail: e.detail,
      bedNumber: req.params.bedNumber,
      locationId: req.params.id,
      tentIndex: req.params.tent,
      blockIndex: req.params.block,
      timestamp: new Date().toISOString()
    });
    if (e.code === '23P01') {
      return res.status(409).json({ 
        error: 'overlapping_allocation',
        message: 'Cannot update: The new dates conflict with an existing booking',
        detail: e.detail
      });
    }
    res.status(500).json({ error: 'edit_failed', message: e.message });
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
          AND end_date >= ${todaySQL}
        ORDER BY created_at DESC
        LIMIT 1
      )
    `;
    const r = await execQuery(delQ, [blockId, bedNumber]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'no_active_allocation' });
    await logAudit(req, 'deallocate', 'allocation', null, { locationId, tentIndex, blockIndex, bedNumber });
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
            AND a.end_date >= ${todaySQL}
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
    await logAudit(req, 'batch_deallocate', 'batch', blockId, { locationId, tentIndex, blockIndex, bedNumbers, success: Number(row.success || 0), failed: errors.length });
    res.json({ ok: true, success: Number(row.success || 0), errors });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'deallocate_batch_failed' });
  }
});

// POST /api/locations/:id/tents/:tent/blocks/:block/beds/batch-edit
// body: { bedNumbers: number[], updates: { name?, phone?, gender?, start_date?, end_date? } }
app.post('/api/locations/:id/tents/:tent/blocks/:block/beds/batch-edit', async (req, res) => {
  try {
    const locationId = Number(req.params.id);
    const tentIndex = Number(req.params.tent);
    const blockIndex = Number(req.params.block);
    const bedNumbers = Array.isArray(req.body?.bedNumbers) ? req.body.bedNumbers.map(Number).filter(n=>Number.isFinite(n)) : [];
    if (bedNumbers.length === 0) return res.status(400).json({ error: 'no_beds' });

    const updates = req.body?.updates || {};
    const { name, phone, gender, start_date, end_date } = updates;

    // Validate at least one update field provided
    if (!name && !phone && !gender && !start_date && !end_date) {
      return res.status(400).json({ error: 'no_updates' });
    }

    // Validate block and obtain block_id
    const v = await execQuery(`
      SELECT b.id, b.size
      FROM blocks b JOIN tents t ON t.id = b.tent_id
      WHERE t.location_id = $1 AND t.tent_index = $2 AND b.block_index = $3
    `, [locationId, tentIndex, blockIndex]);
    if (!v.rowCount) return res.status(404).json({ error: 'block_not_found' });
    const blockId = Number(v.rows[0].id);

    // Validate and normalize gender if provided
    let normalizedGender = gender;
    if (gender !== undefined) {
      const validGenders = ['Male', 'Female', 'Other'];
      normalizedGender = gender && gender.trim() && validGenders.includes(gender.trim()) 
        ? gender.trim() 
        : 'Other';
      
      // Validate gender restriction for the block
      try {
        await validateGenderRestriction(locationId, tentIndex, blockIndex, normalizedGender);
      } catch (e) {
        return res.status(400).json({ error: 'gender_restriction_violation', message: e.message });
      }
    }

    // Build dynamic SET clause
    const setClauses = [];
    const params = [blockId, bedNumbers];
    let paramIndex = 3;

    if (name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      params.push(name);
    }
    if (phone !== undefined) {
      setClauses.push(`phone = $${paramIndex++}`);
      params.push(phone);
    }
    if (normalizedGender !== undefined) {
      setClauses.push(`gender = $${paramIndex++}`);
      params.push(normalizedGender);
    }
    if (start_date !== undefined) {
      setClauses.push(`start_date = $${paramIndex++}`);
      params.push(start_date);
    }
    if (end_date !== undefined) {
      setClauses.push(`end_date = $${paramIndex++}`);
      params.push(end_date);
    }

    // Always update updated_at
    setClauses.push('updated_at = NOW()');

    // One set-based update to edit latest active allocation per requested bed
    const sql = `
      WITH latest AS (
        SELECT id, bed_number
        FROM (
          SELECT a.id, a.bed_number, ROW_NUMBER() OVER (PARTITION BY a.bed_number ORDER BY a.created_at DESC) rn
          FROM allocations a
          WHERE a.block_id = $1
            AND a.bed_number = ANY($2::int[])
            AND a.deleted_at IS NULL
            AND a.end_date >= ${todaySQL}
        ) s
        WHERE rn = 1
      ), upd AS (
        UPDATE allocations a
        SET ${setClauses.join(', ')}
        FROM latest l
        WHERE a.id = l.id
        RETURNING l.bed_number
      )
      SELECT 
        (SELECT COUNT(*) FROM upd) AS success,
        (SELECT ARRAY(SELECT unnest($2::int[]) EXCEPT SELECT bed_number FROM latest)) AS no_active
    `;
    const r = await execQuery(sql, params);
    const row = r.rows?.[0] || { success: 0, no_active: [] };
    const errors = (row.no_active || []).map(bn => ({ bedNumber: Number(bn), error: 'no_active_allocation' }));
    await logAudit(req, 'batch_edit', 'batch', blockId, { locationId, tentIndex, blockIndex, bedNumbers, updates, success: Number(row.success || 0), failed: errors.length });
    res.json({ ok: true, success: Number(row.success || 0), errors });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'batch_edit_failed' });
  }
});
