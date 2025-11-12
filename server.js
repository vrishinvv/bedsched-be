import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
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
    
    // Get real client IP (handles proxies correctly)
    const ipAddress = (
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
      req.headers['x-real-ip'] || 
      req.ip || 
      req.connection?.remoteAddress || 
      'unknown'
    );
    
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
  origin: ['http://localhost:3000', 
    'https://sssenclave.vercel.app',
    'https://sssenclave-dev.vercel.app',
    'https://bedsched-fe.vercel.app'],
  credentials: true,
  optionsSuccessStatus: 200,
  allowedHeaders: ['Content-Type', 'Authorization']
};

// Trust proxy to get real client IP (important for accurate audit logs)
app.set('trust proxy', true);

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
  try {
    // Start transaction
    await execQuery('BEGIN');
    
    console.log('[SEED] Starting database seed...');
    
    // Clear existing data in reverse dependency order
    await execQuery('DELETE FROM audit_logs');
    await execQuery('DELETE FROM allocations');
    await execQuery('DELETE FROM blocks');
    await execQuery('DELETE FROM tents');
    await execQuery('DELETE FROM users');
    await execQuery('DELETE FROM locations');
    
    console.log('[SEED] Cleared all existing data');

    // Helper function to distribute beds into blocks
    function createBlocks(tentSize) {
      const blocks = [];
      let remaining = tentSize;
      let blockIndex = 1;
      
      while (remaining > 0) {
        if (remaining < 100) {
          // Merge small remainder into last block
          if (blocks.length > 0) {
            blocks[blocks.length - 1] += remaining;
          } else {
            blocks.push(remaining); // Edge case: tiny tent
          }
          break;
        } else if (tentSize < 200) {
          // Small tent: use 100 beds/block
          const blockSize = Math.min(100, remaining);
          blocks.push(blockSize);
          remaining -= blockSize;
        } else {
          // Large tent: use 250 beds/block
          const blockSize = Math.min(250, remaining);
          blocks.push(blockSize);
          remaining -= blockSize;
        }
      }
      
      return blocks;
    }

    // Location data with shortcodes for user generation
    const locationData = [
      { name: 'Anand Vilas Enclave', shortcode: 'ave', capacity: 850, tents: 1, gender: 'both', landmark: 'Chaitanya Jyoti' },
      { name: 'Brindavan Enclave', shortcode: 'be', capacity: 2100, tents: 2, gender: 'both', landmark: 'Electricity Board' },
      { name: 'Sai Sruthi Enclave', shortcode: 'sse', capacity: 1800, tents: 1, gender: 'both', landmark: 'APSRTC Bus Depot' },
      { name: 'Dharmakshetra Enclave', shortcode: 'de', capacity: 1400, tents: 2, gender: 'both', landmark: 'Sai Hira Hall' },
      { name: 'Shivam Enclave', shortcode: 'she', capacity: 4000, tents: 3, gender: 'both', landmark: 'West South' },
      { name: 'Sundaram Enclave', shortcode: 'sue', capacity: 6000, tents: 7, gender: 'both', landmark: 'West North' },
      { name: 'New Block B Basement', shortcode: 'nbbb', capacity: 650, tents: 1, tentName: 'Basement', blocksPerTent: 7, gender: 'female_only', landmark: 'New Block B Basement' },
      { name: 'New Block A', shortcode: 'nba', capacity: 950, tents: 1, tentName: 'First Floor', blocksPerTent: 6, gender: 'female_only', landmark: 'New Block A' },
      { name: 'New Block B', shortcode: 'nbb', capacity: 480, tents: 1, tentName: 'First Floor', blocksPerTent: 3, gender: 'male_only', landmark: 'New Block B' }
    ];

    console.log('[SEED] Creating locations...');
    
    // Batch insert all locations
    const locationValues = locationData.map((_, i) => 
      `($${i * 2 + 1}, $${i * 2 + 2})`
    ).join(', ');
    const locationParams = locationData.flatMap(loc => [loc.name, loc.capacity]);
    
    const locResult = await execQuery(`
      INSERT INTO locations(name, capacity) 
      VALUES ${locationValues}
      RETURNING id, name
    `, locationParams);
    
    // Map results back with original data
    const locationInserts = locResult.rows.map((row, i) => ({
      ...locationData[i],
      id: row.id
    }));
    
    console.log(`[SEED] Created ${locationInserts.length} locations`);

    // Create tents and blocks
    let totalTents = 0;
    let totalBlocks = 0;
    
    // Helper to generate tent name
    const getTentName = (loc, tentIndex, totalTents) => {
      if (loc.tentName) return loc.tentName; // Specific name provided
      const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      return `Tent ${letters[tentIndex - 1]}`;
    };
    
    // Helper to generate block name
    const getBlockName = (blockIndex) => {
      return `Block ${blockIndex}`;
    };
    
    // Prepare all tent data
    const allTentData = [];
    const allBlockData = [];
    
    for (const loc of locationInserts) {
      let remainingCapacity = loc.capacity;
      
      for (let tentIndex = 1; tentIndex <= loc.tents; tentIndex++) {
        // Distribute capacity evenly, giving any remainder to the last tent
        let tentSize;
        if (tentIndex === loc.tents) {
          tentSize = remainingCapacity; // Last tent gets all remaining
        } else {
          tentSize = Math.floor(loc.capacity / loc.tents);
          remainingCapacity -= tentSize;
        }
        
        allTentData.push({
          location_id: loc.id,
          location_name: loc.name,
          tent_index: tentIndex,
          tent_name: getTentName(loc, tentIndex, loc.tents),
          size: tentSize,
          gender: loc.gender,
          blocks_per_tent: loc.blocksPerTent // For special locations
        });
      }
    }
    
    // Batch insert all tents
    if (allTentData.length > 0) {
      const tentValues = allTentData.map((_, i) => 
        `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`
      ).join(', ');
      const tentParams = allTentData.flatMap(t => [t.location_id, t.tent_index, t.tent_name, t.size]);
      
      const tentResult = await execQuery(`
        INSERT INTO tents(location_id, tent_index, name, size) 
        VALUES ${tentValues}
        RETURNING id, location_id, tent_index, name, size
      `, tentParams);
      
      totalTents = tentResult.rows.length;
      
      // Prepare block data for each tent
      for (let i = 0; i < tentResult.rows.length; i++) {
        const tent = tentResult.rows[i];
        const tentData = allTentData[i];
        
        // If blocksPerTent is specified, create exact number of blocks with equal distribution
        let blockSizes;
        if (tentData.blocks_per_tent) {
          const blocksCount = tentData.blocks_per_tent;
          const baseSize = Math.floor(tent.size / blocksCount);
          const remainder = tent.size % blocksCount;
          blockSizes = [];
          for (let j = 0; j < blocksCount; j++) {
            // Distribute remainder across first blocks
            blockSizes.push(baseSize + (j < remainder ? 1 : 0));
          }
        } else {
          // Use default block creation logic
          blockSizes = createBlocks(tent.size);
        }
        
        for (let blockIndex = 0; blockIndex < blockSizes.length; blockIndex++) {
          allBlockData.push({
            location_id: tent.location_id,
            tent_id: tent.id,
            tent_index: tent.tent_index,
            block_index: blockIndex + 1,
            block_name: getBlockName(blockIndex + 1),
            size: blockSizes[blockIndex],
            gender: tentData.gender
          });
        }
      }
      
      // Batch insert all blocks
      if (allBlockData.length > 0) {
        const blockValues = allBlockData.map((_, i) => 
          `($${i * 7 + 1}, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}, $${i * 7 + 7})`
        ).join(', ');
        const blockParams = allBlockData.flatMap(b => 
          [b.location_id, b.tent_id, b.tent_index, b.block_index, b.block_name, b.size, b.gender]
        );
        
        await execQuery(`
          INSERT INTO blocks(location_id, tent_id, tent_index, block_index, name, size, gender_restriction)
          VALUES ${blockValues}
        `, blockParams);
        
        totalBlocks = allBlockData.length;
      }
    }
    
    console.log(`[SEED] Created ${totalTents} tents and ${totalBlocks} blocks`);

    // Create 20 users for each location (username = password) - BATCH INSERT
    console.log('[SEED] Creating location users...');
    
    const userValues = [];
    const userParams = [];
    let paramIndex = 1;
    
    for (const loc of locationInserts) {
      for (let i = 1; i <= 20; i++) {
        const username = `${loc.shortcode}_${i}`;
        const password = username; // username = password
        
        userValues.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3})`);
        userParams.push(username, password, 'location_user', loc.id);
        paramIndex += 4;
      }
      
      console.log(`[SEED] Prepared 20 users for ${loc.name} (${loc.shortcode}_1 to ${loc.shortcode}_20, password = username)`);
    }
    
    // Batch insert all users at once
    await execQuery(`
      INSERT INTO users(username, password, role, location_id) 
      VALUES ${userValues.join(', ')}
    `, userParams);
    
    console.log(`[SEED] Created ${locationInserts.length * 20} users in batch`);

    // Recreate admin users (they were deleted during seed)
    await execQuery(`
      INSERT INTO users(username, password, role)
      VALUES ('admin', 'admin', 'admin'), ('dashboard', 'dashboard', 'dashboard')
      ON CONFLICT (username) DO NOTHING
    `);
    console.log('[SEED] Recreated admin and dashboard users');

    console.log('[SEED] No dummy allocations created - clean slate ready!');

    // Get summary
    const summary = await execQuery(`
      SELECT 
        l.name,
        l.capacity,
        COUNT(DISTINCT t.id) as tent_count,
        COUNT(DISTINCT b.id) as block_count
      FROM locations l
      LEFT JOIN tents t ON t.location_id = l.id
      LEFT JOIN blocks b ON b.tent_id = t.id
      GROUP BY l.id, l.name, l.capacity
      ORDER BY l.id
    `);

    await execQuery('COMMIT');
    
    console.log('[SEED] Database seed completed successfully!');

    res.json({
      success: true,
      message: 'Database seeded successfully',
      summary: summary.rows,
      credentials: locationInserts.flatMap(loc => 
        Array.from({ length: 20 }, (_, i) => ({
          location: loc.name,
          username: `${loc.shortcode}_${i + 1}`,
          password: `${loc.shortcode}_${i + 1}` // username = password
        }))
      )
    });
  } catch (e) {
    await execQuery('ROLLBACK');
    console.error('[SEED ERROR]', e);
    res.status(500).json({ error: 'seed_failed', message: e.message });
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
// body: { name, phone, gender, startDate, endDate, emergencyPhone, personPhotoKey, aadhaarPhotoKey }
app.post('/api/locations/:id/beds/:bedNumber/allocate', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const bedNumber = Number(req.params.bedNumber);
    await validateBedWithinCapacity(id, bedNumber);

    const { name, phone, gender, startDate, endDate, emergencyPhone, personPhotoKey, aadhaarPhotoKey } = req.body || {};
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
      INSERT INTO allocations(location_id, bed_number, name, phone, gender, start_date, end_date, emergency_phone, person_photo_key, aadhaar_photo_key)
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
      emergencyPhone || null,
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

/* --------------------------------- Table View -------------------------------- */
app.get('/api/allocations/table-view', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || !['admin', 'location_user'].includes(user.role)) return res.status(403).json({ error: 'forbidden' });

    let { 
      page = 1, 
      limit = 50, 
      sortField = 'updated_at', 
      sortOrder = 'desc',
      search = '',
      startDate = '',
      endDate = '',
      gender = '',
      status = '', // comma-separated: active,expired,left_early,no_show,booking_error,other
      allocatedBy = '', // filter by username who allocated
      location_id = '',
      tent_index = '',
      block_index = ''
    } = req.query;

    // Force location_user to only see their location's data
    if (user.role === 'location_user' && user.locationId) {
      location_id = String(user.locationId);
    }
    
    const offset = (Number(page) - 1) * Number(limit);
    
    // Validate sortField to prevent SQL injection
    const allowedSortFields = ['name', 'phone', 'start_date', 'end_date', 'created_at', 'updated_at'];
    const validSortField = allowedSortFields.includes(sortField) ? sortField : 'updated_at';
    const validSortOrder = sortOrder?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // Build WHERE conditions
    let whereConditions = [];
    let params = [];
    let paramCounter = 1;

    // Search filter
    if (search) {
      whereConditions.push(`(LOWER(a.name) LIKE $${paramCounter} OR a.phone LIKE $${paramCounter})`);
      params.push(`%${search.toLowerCase()}%`);
      paramCounter++;
    }

    // Date range filters - filter by record creation date
    if (startDate) {
      whereConditions.push(`DATE(a.created_at) >= $${paramCounter}`);
      params.push(startDate);
      paramCounter++;
    }

    if (endDate) {
      whereConditions.push(`DATE(a.created_at) <= $${paramCounter}`);
      params.push(endDate);
      paramCounter++;
    }

    // Gender filter
    if (gender) {
      whereConditions.push(`LOWER(a.gender) = $${paramCounter}`);
      params.push(gender.toLowerCase());
      paramCounter++;
    }

    // Location filter
    if (location_id) {
      whereConditions.push(`a.location_id = $${paramCounter}`);
      params.push(location_id);
      paramCounter++;
    }

    // Tent filter
    if (tent_index) {
      whereConditions.push(`a.tent_index = $${paramCounter}`);
      params.push(tent_index);
      paramCounter++;
    }

    // Block filter
    if (block_index) {
      whereConditions.push(`a.block_index = $${paramCounter}`);
      params.push(block_index);
      paramCounter++;
    }

    // Status filter
    if (status) {
      const statuses = status.split(',').map(s => s.trim());
      const statusConditions = [];
      
      const today = new Date().toISOString().split('T')[0];
      
      if (statuses.includes('active')) {
        statusConditions.push(`(a.deleted_at IS NULL AND a.end_date >= '${today}')`);
      }
      if (statuses.includes('expired')) {
        statusConditions.push(`(a.deleted_at IS NULL AND a.end_date < '${today}')`);
      }
      if (statuses.includes('left_early')) {
        statusConditions.push(`(a.deleted_at IS NOT NULL AND EXISTS (
          SELECT 1 FROM audit_logs al 
          WHERE al.action = 'deallocate' 
            AND al.entity_type = 'allocation' 
            AND al.entity_id = a.id 
            AND al.details->>'reason' = 'left_early'
        ))`);
      }
      if (statuses.includes('no_show')) {
        statusConditions.push(`(a.deleted_at IS NOT NULL AND EXISTS (
          SELECT 1 FROM audit_logs al 
          WHERE al.action = 'deallocate' 
            AND al.entity_type = 'allocation' 
            AND al.entity_id = a.id 
            AND al.details->>'reason' = 'no_show'
        ))`);
      }
      if (statuses.includes('booking_error')) {
        statusConditions.push(`(a.deleted_at IS NOT NULL AND EXISTS (
          SELECT 1 FROM audit_logs al 
          WHERE al.action = 'deallocate' 
            AND al.entity_type = 'allocation' 
            AND al.entity_id = a.id 
            AND al.details->>'reason' = 'booking_error'
        ))`);
      }
      if (statuses.includes('other')) {
        statusConditions.push(`(a.deleted_at IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM audit_logs al 
          WHERE al.action = 'deallocate' 
            AND al.entity_type = 'allocation' 
            AND al.entity_id = a.id 
            AND al.details->>'reason' IN ('left_early', 'no_show', 'booking_error')
        ))`);
      }
      
      if (statusConditions.length > 0) {
        whereConditions.push(`(${statusConditions.join(' OR ')})`);
      }
    }

    const whereClause = whereConditions.join(' AND ');

    const countQuery = `
      SELECT COUNT(*) as total
      FROM allocations a
      WHERE ${whereClause}
    `;
    const countResult = await execQuery(countQuery, params);
    const total = Number(countResult.rows[0]?.total || 0);

    const dataQuery = `
      SELECT 
        a.id,
        a.name,
        a.phone,
        a.gender,
        a.start_date,
        a.end_date,
        a.created_at,
        a.updated_at,
        a.deleted_at,
        a.bed_number,
        l.id as location_id,
        l.name as location_name,
        t.tent_index,
        t.name as tent_name,
        b.block_index,
        b.name as block_name,
        COALESCE(creator.username, 'Unknown') as allocated_by,
        CASE 
          WHEN a.deleted_at IS NOT NULL THEN
            COALESCE(
              (SELECT al.details->>'reason' 
               FROM audit_logs al 
               WHERE al.action = 'deallocate' 
                 AND al.entity_type = 'allocation' 
                 AND al.entity_id = a.id 
               ORDER BY al.created_at DESC 
               LIMIT 1
              ), 'not_specified'
            )
          ELSE NULL
        END as reason
      FROM allocations a
      JOIN blocks b ON a.block_id = b.id
      JOIN tents t ON b.tent_id = t.id
      JOIN locations l ON t.location_id = l.id
      LEFT JOIN LATERAL (
        SELECT username
        FROM audit_logs
        WHERE entity_type = 'allocation'
          AND entity_id = a.id
          AND action IN ('allocate', 'bulk_allocate', 'smart_reserve')
        ORDER BY created_at ASC
        LIMIT 1
      ) creator ON true
      WHERE ${whereClause}
      ${allocatedBy ? `AND LOWER(creator.username) = $${paramCounter}` : ''}
      ORDER BY a.${validSortField} ${validSortOrder}
      LIMIT $${paramCounter + (allocatedBy ? 1 : 0)} OFFSET $${paramCounter + (allocatedBy ? 2 : 1)}
    `;
    if (allocatedBy) {
      params.push(allocatedBy.toLowerCase());
      paramCounter++;
    }
    params.push(Number(limit), offset);
    const dataResult = await execQuery(dataQuery, params);

    res.json({
      items: dataResult.rows,
      total,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (e) {
    console.error('Table view error:', e);
    res.status(500).json({ error: 'fetch_table_view_failed' });
  }
});

/* --------------------------------- Get Users for Filter -------------------------------- */
app.get('/api/users/list', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || !['admin', 'location_user'].includes(user.role)) return res.status(403).json({ error: 'forbidden' });

    const result = await execQuery(`
      SELECT DISTINCT username 
      FROM users 
      ORDER BY username
    `);
    
    res.json({ users: result.rows.map(r => r.username) });
  } catch (e) {
    console.error('Get users error:', e);
    res.status(500).json({ error: 'fetch_users_failed' });
  }
});

/* --------------------------------- Send CSV via Email -------------------------------- */
app.post('/api/allocations/send-csv', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });

    const { email, filters } = req.body;
    
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'invalid_email', message: 'Valid email address is required' });
    }

    const {
      search = '',
      startDate = '',
      endDate = '',
      gender = '',
      status = '',
      allocatedBy = '',
      location_id = '',
      tent_index = '',
      block_index = '',
      sortField = 'updated_at',
      sortOrder = 'desc'
    } = filters || {};

    // Validate sortField to prevent SQL injection
    const allowedSortFields = ['name', 'phone', 'start_date', 'end_date', 'created_at', 'updated_at'];
    const validSortField = allowedSortFields.includes(sortField) ? sortField : 'updated_at';
    const validSortOrder = sortOrder?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // Build WHERE conditions (same as table-view)
    let whereConditions = [];
    let params = [];
    let paramCounter = 1;

    if (search) {
      whereConditions.push(`(LOWER(a.name) LIKE $${paramCounter} OR a.phone LIKE $${paramCounter})`);
      params.push(`%${search.toLowerCase()}%`);
      paramCounter++;
    }

    if (startDate) {
      whereConditions.push(`DATE(a.created_at) >= $${paramCounter}`);
      params.push(startDate);
      paramCounter++;
    }

    if (endDate) {
      whereConditions.push(`DATE(a.created_at) <= $${paramCounter}`);
      params.push(endDate);
      paramCounter++;
    }

    if (gender) {
      whereConditions.push(`LOWER(a.gender) = $${paramCounter}`);
      params.push(gender.toLowerCase());
      paramCounter++;
    }

    if (location_id) {
      whereConditions.push(`a.location_id = $${paramCounter}`);
      params.push(location_id);
      paramCounter++;
    }

    if (tent_index) {
      whereConditions.push(`a.tent_index = $${paramCounter}`);
      params.push(tent_index);
      paramCounter++;
    }

    if (block_index) {
      whereConditions.push(`a.block_index = $${paramCounter}`);
      params.push(block_index);
      paramCounter++;
    }

    if (status) {
      const statuses = status.split(',').map(s => s.trim());
      const statusConditions = [];
      const today = new Date().toISOString().split('T')[0];
      
      if (statuses.includes('active')) {
        statusConditions.push(`(a.deleted_at IS NULL AND a.end_date >= '${today}')`);
      }
      if (statuses.includes('expired')) {
        statusConditions.push(`(a.deleted_at IS NULL AND a.end_date < '${today}')`);
      }
      if (statuses.includes('left_early')) {
        statusConditions.push(`(a.deleted_at IS NOT NULL AND EXISTS (
          SELECT 1 FROM audit_logs al 
          WHERE al.action = 'deallocate' 
            AND al.entity_type = 'allocation' 
            AND al.entity_id = a.id 
            AND al.details->>'reason' = 'left_early'
        ))`);
      }
      if (statuses.includes('no_show')) {
        statusConditions.push(`(a.deleted_at IS NOT NULL AND EXISTS (
          SELECT 1 FROM audit_logs al 
          WHERE al.action = 'deallocate' 
            AND al.entity_type = 'allocation' 
            AND al.entity_id = a.id 
            AND al.details->>'reason' = 'no_show'
        ))`);
      }
      if (statuses.includes('booking_error')) {
        statusConditions.push(`(a.deleted_at IS NOT NULL AND EXISTS (
          SELECT 1 FROM audit_logs al 
          WHERE al.action = 'deallocate' 
            AND al.entity_type = 'allocation' 
            AND al.entity_id = a.id 
            AND al.details->>'reason' = 'booking_error'
        ))`);
      }
      if (statuses.includes('other')) {
        statusConditions.push(`(a.deleted_at IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM audit_logs al 
          WHERE al.action = 'deallocate' 
            AND al.entity_type = 'allocation' 
            AND al.entity_id = a.id 
            AND al.details->>'reason' IN ('left_early', 'no_show', 'booking_error')
        ))`);
      }
      
      if (statusConditions.length > 0) {
        whereConditions.push(`(${statusConditions.join(' OR ')})`);
      }
    }

    const whereClause = whereConditions.length > 0 ? whereConditions.join(' AND ') : '1=1';

    // Fetch ALL data (no pagination)
    const dataQuery = `
      SELECT 
        a.id,
        a.name,
        a.phone,
        a.gender,
        a.start_date,
        a.end_date,
        a.created_at,
        a.updated_at,
        a.deleted_at,
        a.bed_number,
        l.id as location_id,
        l.name as location_name,
        t.tent_index,
        t.name as tent_name,
        b.block_index,
        b.name as block_name,
        COALESCE(creator.username, 'Unknown') as allocated_by,
        CASE 
          WHEN a.deleted_at IS NOT NULL THEN
            COALESCE(
              (SELECT al.details->>'reason' 
               FROM audit_logs al 
               WHERE al.action = 'deallocate' 
                 AND al.entity_type = 'allocation' 
                 AND al.entity_id = a.id 
               ORDER BY al.created_at DESC 
               LIMIT 1
              ), 'not_specified'
            )
          ELSE NULL
        END as reason
      FROM allocations a
      JOIN blocks b ON a.block_id = b.id
      JOIN tents t ON b.tent_id = t.id
      JOIN locations l ON t.location_id = l.id
      LEFT JOIN LATERAL (
        SELECT username
        FROM audit_logs
        WHERE entity_type = 'allocation'
          AND entity_id = a.id
          AND action IN ('allocate', 'bulk_allocate', 'smart_reserve')
        ORDER BY created_at ASC
        LIMIT 1
      ) creator ON true
      WHERE ${whereClause}
      ${allocatedBy ? `AND LOWER(creator.username) = $${paramCounter}` : ''}
      ORDER BY a.${validSortField} ${validSortOrder}
    `;
    
    if (allocatedBy) {
      params.push(allocatedBy.toLowerCase());
    }

    const dataResult = await execQuery(dataQuery, params);

    // Generate CSV
    const columns = [
      'id', 'name', 'phone', 'gender', 'location_name', 'tent_name', 'block_name', 'bed_number',
      'start_date', 'end_date', 'created_at', 'updated_at', 'allocated_by', 'deleted_at', 'reason'
    ];

    const headers = columns.join(',');
    const csvRows = dataResult.rows.map(row => {
      return columns.map(col => {
        const val = row[col];
        if (val === null || val === undefined) return '';
        const str = String(val).replace(/"/g, '""');
        return `"${str}"`;
      }).join(',');
    });

    const csvContent = [headers, ...csvRows].join('\n');

    // Import Resend
    const { Resend } = await import('resend');
    const resend = new Resend(config.resendApiKey);

    // Send email - For now, send to verified email (Resend limitation in dev mode)
    // In production, verify a domain and use that for 'from' address
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const recipientEmail = config.backupEmail; // Send to verified email
    
    const { data, error } = await resend.emails.send({
      from: 'BedSched <onboarding@resend.dev>',
      to: [recipientEmail],
      subject: `BedSched Export for ${email} - ${timestamp}`,
      html: `
        <h2>BedSched Allocations Export</h2>
        <p><strong>Note:</strong> This export was requested by <strong>${user.username}</strong> to be sent to <strong>${email}</strong></p>
        <p>Due to Resend email limitations in development mode, this is being sent to the verified email address. Please forward this to ${email} if needed.</p>
        <hr />
        <p>The filtered allocations data is attached.</p>
        <p><strong>Export Details:</strong></p>
        <ul>
          <li>Total Records: ${dataResult.rows.length}</li>
          <li>Generated: ${new Date().toLocaleString()}</li>
          <li>Requested by: ${user.username}</li>
          <li>Intended recipient: ${email}</li>
        </ul>
        <p>The CSV file contains all allocations matching the filter criteria.</p>
      `,
      attachments: [
        {
          filename: `allocations-export-${timestamp}.csv`,
          content: Buffer.from(csvContent).toString('base64')
        }
      ]
    });

    if (error) {
      console.error('[SEND_CSV] Error sending email:', error);
      return res.status(500).json({ error: 'email_send_failed', message: error.message });
    }

    await logAudit(req, 'send_csv_export', 'allocations', null, { 
      requestedEmail: email,
      actualRecipient: recipientEmail,
      recordCount: dataResult.rows.length,
      filters 
    });

    res.json({ 
      ok: true, 
      message: `CSV sent to ${recipientEmail} (intended for ${email}). Please check your email.`,
      recordCount: dataResult.rows.length 
    });

  } catch (e) {
    console.error('Send CSV error:', e);
    res.status(500).json({ error: 'send_csv_failed', message: e.message });
  }
});

/* --------------------------------- Historical Deallocations -------------------------------- */
// GET /api/allocations/historical-deallocations?date=YYYY-MM-DD
app.get('/api/allocations/historical-deallocations', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || !['admin', 'location_user'].includes(user.role)) return res.status(403).json({ error: 'forbidden' });

    let { date, location_id, tent_index, block_index } = req.query;
    if (!date) {
      return res.status(400).json({ error: 'missing_date', message: 'Date parameter is required' });
    }

    // Force location_user to only see their location's data
    if (user.role === 'location_user' && user.locationId) {
      location_id = String(user.locationId);
    }

    // Build WHERE conditions for filters
    let filterConditions = '';
    let filterParams = [];
    let paramCounter = 2; // Start at 2 since $1 is used for date

    if (location_id) {
      filterConditions += ` AND l.id = $${paramCounter}`;
      filterParams.push(location_id);
      paramCounter++;
    }
    if (tent_index) {
      filterConditions += ` AND t.tent_index = $${paramCounter}`;
      filterParams.push(tent_index);
      paramCounter++;
    }
    if (block_index) {
      filterConditions += ` AND b.block_index = $${paramCounter}`;
      filterParams.push(block_index);
      paramCounter++;
    }

    // Get manual deallocations for the selected date (with or without audit logs)
    const manualDeallocationsQuery = `
      SELECT 
        a.id,
        a.name,
        a.phone,
        a.gender,
        a.start_date,
        a.end_date,
        a.bed_number,
        a.deleted_at,
        l.id as location_id,
        l.name as location_name,
        t.tent_index,
        t.name as tent_name,
        b.block_index,
        b.name as block_name,
        COALESCE(al.details->>'reason', 'not_specified') as reason,
        u.username as deallocated_by
      FROM allocations a
      JOIN blocks b ON a.block_id = b.id
      JOIN tents t ON b.tent_id = t.id
      JOIN locations l ON t.location_id = l.id
      LEFT JOIN audit_logs al ON al.action = 'deallocate' 
        AND al.entity_type = 'allocation' 
        AND al.entity_id = a.id
      LEFT JOIN users u ON al.user_id = u.id
      WHERE a.deleted_at IS NOT NULL
        AND DATE(a.deleted_at) = $1
        ${filterConditions}
      ORDER BY a.deleted_at DESC
    `;

    // Get allocations that expired on the previous day only
    const previousDate = new Date(date);
    previousDate.setDate(previousDate.getDate() - 1);
    const previousDateStr = previousDate.toISOString().split('T')[0];

    const expiredAllocationsQuery = `
      SELECT 
        a.id,
        a.name,
        a.phone,
        a.gender,
        a.start_date,
        a.end_date,
        a.bed_number,
        l.id as location_id,
        l.name as location_name,
        t.tent_index,
        t.name as tent_name,
        b.block_index,
        b.name as block_name
      FROM allocations a
      JOIN blocks b ON a.block_id = b.id
      JOIN tents t ON b.tent_id = t.id
      JOIN locations l ON t.location_id = l.id
      WHERE a.deleted_at IS NULL
        AND DATE(a.end_date) = $1
        AND a.status = 'confirmed'
        ${filterConditions}
      ORDER BY a.end_date DESC
    `;

    const manualParams = [date, ...filterParams];
    const expiredParams = [previousDateStr, ...filterParams];

    const [manualResult, expiredResult] = await Promise.all([
      execQuery(manualDeallocationsQuery, manualParams),
      execQuery(expiredAllocationsQuery, expiredParams)
    ]);

    res.json({
      ok: true,
      date,
      previousDate: previousDateStr,
      manualDeallocations: manualResult.rows,
      expiredAllocations: expiredResult.rows,
      manualCount: manualResult.rows.length,
      expiredCount: expiredResult.rows.length
    });
  } catch (e) {
    console.error('Historical deallocations error:', e);
    res.status(500).json({ error: 'fetch_historical_deallocations_failed' });
  }
});

/* --------------------------------- Send Historical Deallocations CSV via Email -------------------------------- */
app.post('/api/allocations/historical-deallocations/send-csv', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });

    const { email, date, location_id = '', tent_index = '', block_index = '' } = req.body;
    
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'invalid_email', message: 'Valid email address is required' });
    }

    if (!date) {
      return res.status(400).json({ error: 'missing_date', message: 'Date is required' });
    }

    // Build WHERE conditions for filters
    let manualWhereConditions = ['a.deleted_at IS NOT NULL', 'DATE(a.deleted_at) = $1'];
    let expiredWhereConditions = ['a.deleted_at IS NULL', 'DATE(a.end_date) = $1', "a.status = 'confirmed'"];
    let params = [date];
    let paramCounter = 2;

    if (location_id) {
      manualWhereConditions.push(`l.id = $${paramCounter}`);
      expiredWhereConditions.push(`l.id = $${paramCounter}`);
      params.push(location_id);
      paramCounter++;
    }
    if (tent_index) {
      manualWhereConditions.push(`t.tent_index = $${paramCounter}`);
      expiredWhereConditions.push(`t.tent_index = $${paramCounter}`);
      params.push(tent_index);
      paramCounter++;
    }
    if (block_index) {
      manualWhereConditions.push(`b.block_index = $${paramCounter}`);
      expiredWhereConditions.push(`b.block_index = $${paramCounter}`);
      params.push(block_index);
      paramCounter++;
    }

    const manualWhereClause = manualWhereConditions.join(' AND ');
    const expiredWhereClause = expiredWhereConditions.join(' AND ');

    // Get manual deallocations
    const manualDeallocationsQuery = `
      SELECT 
        a.id,
        a.name,
        a.phone,
        a.gender,
        a.start_date,
        a.end_date,
        a.bed_number,
        a.deleted_at,
        l.id as location_id,
        l.name as location_name,
        t.tent_index,
        t.name as tent_name,
        b.block_index,
        b.name as block_name,
        COALESCE(al.details->>'reason', 'not_specified') as reason,
        u.username as deallocated_by
      FROM allocations a
      JOIN blocks b ON a.block_id = b.id
      JOIN tents t ON b.tent_id = t.id
      JOIN locations l ON t.location_id = l.id
      LEFT JOIN audit_logs al ON al.action = 'deallocate' 
        AND al.entity_type = 'allocation' 
        AND al.entity_id = a.id
      LEFT JOIN users u ON al.user_id = u.id
      WHERE ${manualWhereClause}
      ORDER BY a.deleted_at DESC
    `;

    // Get expired allocations
    const previousDate = new Date(date);
    previousDate.setDate(previousDate.getDate() - 1);
    const previousDateStr = previousDate.toISOString().split('T')[0];
    
    const expiredParams = [previousDateStr, ...params.slice(1)];
    const expiredAllocationsQuery = `
      SELECT 
        a.id,
        a.name,
        a.phone,
        a.gender,
        a.start_date,
        a.end_date,
        a.bed_number,
        l.id as location_id,
        l.name as location_name,
        t.tent_index,
        t.name as tent_name,
        b.block_index,
        b.name as block_name
      FROM allocations a
      JOIN blocks b ON a.block_id = b.id
      JOIN tents t ON b.tent_id = t.id
      JOIN locations l ON t.location_id = l.id
      WHERE ${expiredWhereClause}
      ORDER BY a.end_date DESC
    `;

    const [manualResult, expiredResult] = await Promise.all([
      execQuery(manualDeallocationsQuery, params),
      execQuery(expiredAllocationsQuery, expiredParams)
    ]);

    // Generate CSV
    const csvRows = [];
    
    // Add expired allocations section
    csvRows.push(`"Section","Expired Allocations on ${previousDateStr}"`);
    csvRows.push('"ID","Name","Phone","Gender","Location","Tent","Block","Bed","Start Date","End Date"');
    expiredResult.rows.forEach(row => {
      csvRows.push([
        row.id,
        row.name || '',
        row.phone || '',
        row.gender || '',
        row.location_name || '',
        row.tent_name || `Tent ${row.tent_index}`,
        row.block_name || `Block ${row.block_index}`,
        row.bed_number,
        row.start_date ? new Date(row.start_date).toISOString().split('T')[0] : '',
        row.end_date ? new Date(row.end_date).toISOString().split('T')[0] : ''
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    });

    csvRows.push(''); // Empty row separator

    // Add manual deallocations section
    csvRows.push(`"Section","Manual Deallocations on ${date}"`);
    csvRows.push('"ID","Name","Phone","Gender","Location","Tent","Block","Bed","Start Date","End Date","Deallocated At","Reason","Deallocated By"');
    manualResult.rows.forEach(row => {
      csvRows.push([
        row.id,
        row.name || '',
        row.phone || '',
        row.gender || '',
        row.location_name || '',
        row.tent_name || `Tent ${row.tent_index}`,
        row.block_name || `Block ${row.block_index}`,
        row.bed_number,
        row.start_date ? new Date(row.start_date).toISOString().split('T')[0] : '',
        row.end_date ? new Date(row.end_date).toISOString().split('T')[0] : '',
        row.deleted_at ? new Date(row.deleted_at).toISOString() : '',
        row.reason || 'not_specified',
        row.deallocated_by || 'System'
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    });

    const csvContent = csvRows.join('\n');

    // Import Resend
    const { Resend } = await import('resend');
    const resend = new Resend(config.resendApiKey);

    // Send email
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const recipientEmail = config.backupEmail;
    const csvBase64 = Buffer.from(csvContent, 'utf-8').toString('base64');
    
    const { data, error } = await resend.emails.send({
      from: 'BedSched <onboarding@resend.dev>',
      to: [recipientEmail],
      subject: `BedSched Historical Deallocations for ${email} - ${date} - ${timestamp}`,
      html: `
        <h2>Historical Deallocations Export</h2>
        <p><strong>Intended recipient:</strong> ${email}</p>
        <p><strong>Note:</strong> Due to Resend limitations in development mode, this email was sent to the verified address.</p>
        <p><strong>Date:</strong> ${date}</p>
        <p><strong>Expired Allocations:</strong> ${expiredResult.rows.length} (expired on ${previousDateStr})</p>
        <p><strong>Manual Deallocations:</strong> ${manualResult.rows.length} (deallocated on ${date})</p>
        <p><strong>Total Records:</strong> ${expiredResult.rows.length + manualResult.rows.length}</p>
        ${location_id ? `<p><strong>Filtered by Location ID:</strong> ${location_id}</p>` : ''}
        ${tent_index ? `<p><strong>Filtered by Tent:</strong> ${tent_index}</p>` : ''}
        ${block_index ? `<p><strong>Filtered by Block:</strong> ${block_index}</p>` : ''}
        <p>The CSV file is attached to this email.</p>
      `,
      attachments: [{
        filename: `historical-deallocations-${date}.csv`,
        content: csvBase64
      }]
    });

    if (error) {
      console.error('Resend error:', error);
      return res.status(500).json({ error: 'email_send_failed', message: error.message });
    }

    await logAudit(req, 'export_historical_deallocations', 'allocation', null, { 
      date, 
      email,
      recordCount: expiredResult.rows.length + manualResult.rows.length,
      expiredCount: expiredResult.rows.length,
      manualCount: manualResult.rows.length
    });

    res.json({
      ok: true,
      message: 'CSV email sent successfully',
      recordCount: expiredResult.rows.length + manualResult.rows.length,
      expiredCount: expiredResult.rows.length,
      manualCount: manualResult.rows.length,
      emailId: data?.id
    });
  } catch (e) {
    console.error('Send historical deallocations CSV error:', e);
    res.status(500).json({ error: 'send_csv_failed', message: e.message });
  }
});

/* --------------------------------- TEST DATA GENERATOR -------------------------------- */

// POST /api/test/generate-dummy-allocations
// WARNING: Only use in development/testing environments!
app.post('/api/test/generate-dummy-allocations', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });

    const { count = 20 } = req.body || {};
    
    // Get multiple locations, tents, and blocks for variety
    const locationsResult = await execQuery('SELECT id FROM locations');
    if (locationsResult.rows.length === 0) {
      return res.status(400).json({ error: 'no_locations_found', message: 'Create locations first' });
    }
    const locations = locationsResult.rows;

    const tentsResult = await execQuery(`
      SELECT t.id, t.tent_index, t.location_id 
      FROM tents t
      WHERE t.location_id = ANY($1)
    `, [locations.map(l => l.id)]);
    if (tentsResult.rows.length === 0) {
      return res.status(400).json({ error: 'no_tents_found', message: 'Create tents first' });
    }
    const tents = tentsResult.rows;

    const blocksResult = await execQuery(`
      SELECT b.id, b.block_index, b.size, b.tent_id, b.location_id
      FROM blocks b
      WHERE b.tent_id = ANY($1)
    `, [tents.map(t => t.id)]);
    if (blocksResult.rows.length === 0) {
      return res.status(400).json({ error: 'no_blocks_found', message: 'Create blocks first' });
    }
    const blocks = blocksResult.rows;

    const names = ['Amit Kumar', 'Priya Sharma', 'Rahul Verma', 'Anjali Patel', 'Vikram Singh', 
                   'Neha Gupta', 'Sanjay Reddy', 'Kavita Desai', 'Arjun Nair', 'Pooja Iyer',
                   'Rajesh Kumar', 'Meera Shah', 'Suresh Rao', 'Divya Menon', 'Karan Joshi'];
    const genders = ['Male', 'Female'];
    const reasons = ['left_early', 'no_show', 'booking_error'];

    const today = new Date();
    const allocationsToInsert = [];
    const allocationsToDelete = [];

    // Prepare all allocations data first
    for (let i = 0; i < count; i++) {
      // Randomly select location, tent, and block for variety
      const block = blocks[Math.floor(Math.random() * blocks.length)];
      const tent = tents.find(t => t.id === block.tent_id);
      const bedNumber = (i % block.size) + 1;
      const name = names[Math.floor(Math.random() * names.length)];
      const gender = genders[Math.floor(Math.random() * genders.length)];
      const phone = `98${Math.floor(10000000 + Math.random() * 90000000)}`;
      
      // Create different scenarios
      const scenario = Math.floor(Math.random() * 5);
      let startDate, endDate, shouldDelete = false, deleteReason = null;

      switch(scenario) {
        case 0: // Expired booking (past dates)
          startDate = new Date(today.getTime() - (15 * 24 * 60 * 60 * 1000)); // 15 days ago
          endDate = new Date(today.getTime() - (2 * 24 * 60 * 60 * 1000)); // 2 days ago
          break;
        
        case 1: // Current active booking
          startDate = new Date(today.getTime() - (3 * 24 * 60 * 60 * 1000)); // 3 days ago
          endDate = new Date(today.getTime() + (5 * 24 * 60 * 60 * 1000)); // 5 days from now
          break;
        
        case 2: // Future booking
          startDate = new Date(today.getTime() + (2 * 24 * 60 * 60 * 1000)); // 2 days from now
          endDate = new Date(today.getTime() + (10 * 24 * 60 * 60 * 1000)); // 10 days from now
          break;
        
        case 3: // Manually deleted (left early)
          startDate = new Date(today.getTime() - (10 * 24 * 60 * 60 * 1000)); // 10 days ago
          endDate = new Date(today.getTime() + (5 * 24 * 60 * 60 * 1000)); // would have ended 5 days from now
          shouldDelete = true;
          deleteReason = 'left_early';
          break;
        
        case 4: // Manually deleted (no show / booking error)
          startDate = new Date(today.getTime() - (5 * 24 * 60 * 60 * 1000)); // 5 days ago
          endDate = new Date(today.getTime() + (7 * 24 * 60 * 60 * 1000)); // 7 days from now
          shouldDelete = true;
          deleteReason = reasons[Math.floor(Math.random() * reasons.length)]; // left_early, no_show, or booking_error
          break;
      }

      const startDateStr = startDate.toISOString().split('T')[0];
      const endDateStr = endDate.toISOString().split('T')[0];

      allocationsToInsert.push({
        locationId: block.location_id,
        tentId: block.tent_id,
        blockId: block.id,
        tentIndex: tent.tent_index,
        blockIndex: block.block_index,
        bedNumber,
        name, phone, gender, startDateStr, endDateStr,
        shouldDelete, deleteReason, scenario
      });
    }

    // Bulk insert all allocations
    const valuesClauses = [];
    const allParams = [];
    let paramIndex = 1;

    for (const alloc of allocationsToInsert) {
      const valuesClause = `($${paramIndex}, $${paramIndex+1}, $${paramIndex+2}, $${paramIndex+3}, $${paramIndex+4}, $${paramIndex+5}, $${paramIndex+6}, $${paramIndex+7}, $${paramIndex+8}, $${paramIndex+9}, $${paramIndex+10}, $${paramIndex+11}, $${paramIndex+12}, $${paramIndex+13}, $${paramIndex+14})`;
      valuesClauses.push(valuesClause);
      // Set was_occupied = false for no_show/booking_error, true otherwise (including left_early)
      const wasOccupied = !alloc.shouldDelete || (alloc.shouldDelete && alloc.deleteReason === 'left_early');
      allParams.push(
        alloc.locationId, alloc.tentId, alloc.blockId, alloc.tentIndex, alloc.blockIndex, alloc.bedNumber,
        alloc.name, alloc.phone, alloc.gender, alloc.startDateStr, alloc.endDateStr, 
        'confirmed', wasOccupied, 'test-person-photo.jpg', 'test-aadhaar-photo.jpg'
      );
      paramIndex += 15;
    }

    const bulkInsertQuery = `
      INSERT INTO allocations(
        location_id, tent_id, block_id, tent_index, block_index, bed_number, 
        name, phone, gender, start_date, end_date, status, was_occupied,
        person_photo_key, aadhaar_photo_key
      )
      VALUES ${valuesClauses.join(', ')}
      ON CONFLICT DO NOTHING
      RETURNING id
    `;

    const insertResult = await execQuery(bulkInsertQuery, allParams);
    const insertedIds = insertResult.rows.map(row => row.id);

    // Prepare bulk deletions and audit logs
    const idsToDelete = [];
    const auditLogValues = [];
    const auditParams = [];
    let auditParamIndex = 1;

    for (let i = 0; i < insertedIds.length; i++) {
      const allocationId = insertedIds[i];
      const originalData = allocationsToInsert[i];

      if (originalData.shouldDelete) {
        idsToDelete.push(allocationId);
        
        // Prepare audit log values
        const auditValuesClause = `($${auditParamIndex}, $${auditParamIndex+1}, $${auditParamIndex+2}, $${auditParamIndex+3}, $${auditParamIndex+4}, $${auditParamIndex+5}, NOW())`;
        auditLogValues.push(auditValuesClause);
        auditParams.push(
          user.id,
          user.username,
          'deallocate',
          'allocation',
          allocationId,
          JSON.stringify({ reason: originalData.deleteReason, phone: originalData.phone, test_data: true })
        );
        auditParamIndex += 6;
      }
    }

    // Bulk soft delete
    if (idsToDelete.length > 0) {
      const deletePlaceholders = idsToDelete.map((_, i) => `$${i + 1}`).join(',');
      await execQuery(
        `UPDATE allocations SET deleted_at = NOW() WHERE id IN (${deletePlaceholders})`,
        idsToDelete
      );

      // Bulk insert audit logs
      const bulkAuditQuery = `
        INSERT INTO audit_logs (user_id, username, action, entity_type, entity_id, details, created_at)
        VALUES ${auditLogValues.join(', ')}
      `;
      await execQuery(bulkAuditQuery, auditParams);
    }

    const createdAllocations = insertedIds.map((id, i) => ({
      id,
      name: allocationsToInsert[i].name,
      bedNumber: allocationsToInsert[i].bedNumber,
      startDate: allocationsToInsert[i].startDateStr,
      endDate: allocationsToInsert[i].endDateStr,
      scenario: ['expired', 'active', 'future', 'deleted_early', 'deleted_other'][allocationsToInsert[i].scenario],
      deleted: allocationsToInsert[i].shouldDelete,
      deleteReason: allocationsToInsert[i].deleteReason
    }));

    res.json({
      ok: true,
      message: 'Dummy allocations created',
      created: insertedIds.length,
      deleted: idsToDelete.length,
      active: insertedIds.length - idsToDelete.length,
      allocations: createdAllocations
    });

  } catch (e) {
    console.error('Generate dummy allocations error:', e);
    res.status(500).json({ error: 'generation_failed', message: e.message });
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
// body: { phone, contactName?, isFamily, maleCount, femaleCount, startDate, endDate, confirmFallback?, emergencyPhone? }
app.post('/api/allocations/smart-reserve', async (req, res) => {
  const { phone, contactName, isFamily, maleCount = 0, femaleCount = 0, startDate, endDate, confirmFallback = false, emergencyPhone } = req.body || {};
  
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
      const cols = `location_id, tent_id, block_id, tent_index, block_index, bed_number, name, phone, gender, start_date, end_date, status, batch_id, is_family, reserved_expires_at, emergency_phone`;
      
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
            batchId, !!isFamily, expiresAt, emergencyPhone || null
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
        a.emergency_phone,
        a.gender,
        TO_CHAR(a.start_date, 'YYYY-MM-DD') as start_date,
        TO_CHAR(a.end_date, 'YYYY-MM-DD') as end_date,
        a.status,
        a.person_photo_key,
        a.aadhaar_photo_key,
        a.deleted_at,
        TO_CHAR(a.created_at, 'YYYY-MM-DD HH24:MI:SS') as created_at,
        l.name as location_name,
        t.name as tent_name,
        b.name as block_name
      FROM allocations a
      JOIN locations l ON l.id = a.location_id
      LEFT JOIN tents t ON t.location_id = a.location_id AND t.tent_index = a.tent_index
      LEFT JOIN blocks b ON b.tent_id = a.tent_id AND b.block_index = a.block_index
      WHERE a.phone = $1
        AND a.end_date >= ${todaySQL}
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
      SELECT id, batch_id, status, reserved_expires_at, location_id, tent_index, block_index, bed_number, gender, start_date, end_date, emergency_phone
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
        gender: r.gender, status: r.status, startDate: r.start_date, endDate: r.end_date, emergencyPhone: r.emergency_phone
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

// PATCH /api/allocations/by-phone/update-name
// body: { phone, name, batchId?, allocationIds? }
app.patch('/api/allocations/by-phone/update-name', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || !['admin', 'location_user'].includes(user.role)) return res.status(403).json({ error: 'forbidden' });
    const { phone, name, batchId, allocationIds } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'missing_phone' });

    const params = [name || null, phone];
    let q = `UPDATE allocations SET name = $1, updated_at = NOW() WHERE phone = $2 AND deleted_at IS NULL`;
    if (batchId) { q += ` AND batch_id = $3`; params.push(batchId); }
    if (Array.isArray(allocationIds) && allocationIds.length) {
      const placeholders = allocationIds.map((_, i) => `$${params.length + i + 1}`).join(',');
      q += ` AND id IN (${placeholders})`;
      params.push(...allocationIds);
    }

    const r = await execQuery(q, params);
    await logAudit(req, 'update_name', 'allocation', null, { phone, name, batchId, allocationIds, updated: r.rowCount });
    res.json({ ok: true, updated: r.rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'update_name_failed' });
  }
});

// PATCH /api/allocations/by-phone/update-emergency-phone
// body: { phone, emergencyPhone, batchId?, allocationIds? }
app.patch('/api/allocations/by-phone/update-emergency-phone', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || !['admin', 'location_user'].includes(user.role)) return res.status(403).json({ error: 'forbidden' });
    const { phone, emergencyPhone, batchId, allocationIds } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'missing_phone' });

    const params = [emergencyPhone || null, phone];
    let q = `UPDATE allocations SET emergency_phone = $1, updated_at = NOW() WHERE phone = $2 AND deleted_at IS NULL`;
    if (batchId) { q += ` AND batch_id = $3`; params.push(batchId); }
    if (Array.isArray(allocationIds) && allocationIds.length) {
      const placeholders = allocationIds.map((_, i) => `$${params.length + i + 1}`).join(',');
      q += ` AND id IN (${placeholders})`;
      params.push(...allocationIds);
    }

    const r = await execQuery(q, params);
    await logAudit(req, 'update_emergency_phone', 'allocation', null, { phone, emergencyPhone, batchId, allocationIds, updated: r.rowCount });
    res.json({ ok: true, updated: r.rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'update_emergency_phone_failed' });
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
// body: { phone, batchId?, allocationIds?, reason? }
app.post('/api/allocations/by-phone/deallocate', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || !['admin', 'location_user'].includes(user.role)) return res.status(403).json({ error: 'forbidden' });
    const { phone, batchId, allocationIds, reason } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'missing_phone' });

    // First, get the allocation IDs that will be deallocated
    let selectBase = `SELECT id FROM allocations WHERE phone = $1 AND deleted_at IS NULL`;
    const selectParams = [phone];
    if (batchId) { 
      selectBase += ` AND batch_id = $${selectParams.push(batchId)}`; 
    }
    if (Array.isArray(allocationIds) && allocationIds.length) {
      const placeholders = allocationIds.map((_, i) => `$${selectParams.length + i + 1}`).join(',');
      selectBase += ` AND id IN (${placeholders})`;
      selectParams.push(...allocationIds);
    }
    const allocationsToDelete = await execQuery(selectBase, selectParams);

    // Now perform the update
    let base = `UPDATE allocations SET deleted_at = NOW(), updated_at = NOW() WHERE phone = $1 AND deleted_at IS NULL`;
    const params = [phone];
    if (batchId) { base += ` AND batch_id = $${params.push(batchId)}`; }
    if (Array.isArray(allocationIds) && allocationIds.length) {
      const placeholders = allocationIds.map((_, i) => `$${params.length + i + 1}`).join(',');
      base += ` AND id IN (${placeholders})`;
      params.push(...allocationIds);
    }
    const r = await execQuery(base, params);

    // Create audit log entries for each deallocated allocation
    if (allocationsToDelete.rows.length > 0) {
      for (const alloc of allocationsToDelete.rows) {
        await execQuery(
          `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [
            user.id,
            'deallocate',
            'allocation',
            alloc.id,
            JSON.stringify({ reason: reason || 'not_specified', phone })
          ]
        );
      }
    }

    res.json({ ok: true, deallocated: r.rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'deallocate_failed' });
  }
});

// GET /api/allocations/departures?date=YYYY-MM-DD&page=1&limit=50&sortField=name&sortOrder=asc
app.get('/api/allocations/departures', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || !['admin', 'location_user'].includes(user.role)) return res.status(403).json({ error: 'forbidden' });
    const date = String(req.query.date || '').trim();
    if (!date) return res.status(400).json({ error: 'missing_date' });

    const { page = 1, limit = 50, sortField = 'bed_number', sortOrder = 'asc', location_id = '', tent_index = '', block_index = '' } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    
    // Validate sortField to prevent SQL injection
    const allowedSortFields = ['name', 'phone', 'location_name', 'tent_index', 'block_index', 'bed_number', 'start_date', 'end_date', 'gender'];
    const validSortField = allowedSortFields.includes(sortField) ? sortField : 'bed_number';
    const validSortOrder = sortOrder?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    // Build WHERE conditions
    let whereConditions = ['a.deleted_at IS NULL', 'a.end_date = $1'];
    let params = [date];
    let paramCounter = 2;

    if (location_id) {
      whereConditions.push(`a.location_id = $${paramCounter}`);
      params.push(location_id);
      paramCounter++;
    }
    if (tent_index) {
      whereConditions.push(`a.tent_index = $${paramCounter}`);
      params.push(tent_index);
      paramCounter++;
    }
    if (block_index) {
      whereConditions.push(`a.block_index = $${paramCounter}`);
      params.push(block_index);
      paramCounter++;
    }

    const whereClause = whereConditions.join(' AND ');

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total
      FROM allocations a
      WHERE ${whereClause}
    `;
    const countResult = await execQuery(countQuery, params);
    const total = Number(countResult.rows[0]?.total || 0);

    // Get paginated data
    params.push(Number(limit), offset);
    const rows = await execQuery(`
      SELECT a.id, a.phone, a.name, a.location_id, l.name as location_name, 
             a.tent_index, t.name as tent_name, a.block_index, b.name as block_name, 
             a.bed_number, a.gender, a.status, a.start_date, a.end_date
      FROM allocations a
      LEFT JOIN locations l ON a.location_id = l.id
      LEFT JOIN tents t ON a.location_id = t.location_id AND a.tent_index = t.tent_index
      LEFT JOIN blocks b ON t.id = b.tent_id AND a.block_index = b.block_index
      WHERE ${whereClause}
      ORDER BY ${validSortField === 'location_name' ? 'l.name' : 'a.' + validSortField} ${validSortOrder}
      LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
    `, params);
    
    await logAudit(req, 'view_departures', 'report', null, { date, count: rows.rows.length });
    res.json({ 
      ok: true, 
      items: rows.rows,
      total,
      page: Number(page),
      limit: Number(limit)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'departures_failed' });
  }
});

/* --------------------------------- Send Departures CSV via Email -------------------------------- */
app.post('/api/allocations/departures/send-csv', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || !['admin', 'location_user'].includes(user.role)) return res.status(403).json({ error: 'forbidden' });

    const { email, date, sortField = 'bed_number', sortOrder = 'asc', location_id = '', tent_index = '', block_index = '' } = req.body;
    
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'invalid_email', message: 'Valid email address is required' });
    }

    if (!date) {
      return res.status(400).json({ error: 'missing_date', message: 'Date is required' });
    }

    // Validate sortField to prevent SQL injection
    const allowedSortFields = ['name', 'phone', 'location_name', 'tent_index', 'block_index', 'bed_number', 'start_date', 'end_date', 'gender'];
    const validSortField = allowedSortFields.includes(sortField) ? sortField : 'bed_number';
    const validSortOrder = sortOrder?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    // Build WHERE conditions
    let whereConditions = ['a.deleted_at IS NULL', 'a.end_date = $1'];
    let params = [date];
    let paramCounter = 2;

    if (location_id) {
      whereConditions.push(`a.location_id = $${paramCounter}`);
      params.push(location_id);
      paramCounter++;
    }
    if (tent_index) {
      whereConditions.push(`a.tent_index = $${paramCounter}`);
      params.push(tent_index);
      paramCounter++;
    }
    if (block_index) {
      whereConditions.push(`a.block_index = $${paramCounter}`);
      params.push(block_index);
      paramCounter++;
    }

    const whereClause = whereConditions.join(' AND ');

    // Fetch ALL data (no pagination)
    const dataQuery = `
      SELECT 
        a.id, 
        a.phone, 
        a.name, 
        a.gender,
        a.location_id, 
        l.name as location_name, 
        a.tent_index, 
        t.name as tent_name, 
        a.block_index, 
        b.name as block_name, 
        a.bed_number, 
        a.status, 
        a.start_date, 
        a.end_date,
        a.created_at
      FROM allocations a
      LEFT JOIN locations l ON a.location_id = l.id
      LEFT JOIN tents t ON a.location_id = t.location_id AND a.tent_index = t.tent_index
      LEFT JOIN blocks b ON t.id = b.tent_id AND a.block_index = b.block_index
      WHERE ${whereClause}
      ORDER BY ${validSortField === 'location_name' ? 'l.name' : 'a.' + validSortField} ${validSortOrder}
    `;

    const dataResult = await execQuery(dataQuery, params);

    // Generate CSV
    const columns = [
      'id', 'name', 'phone', 'gender', 'location_name', 'tent_name', 'block_name', 'bed_number',
      'start_date', 'end_date', 'status', 'created_at'
    ];

    const headers = columns.join(',');
    const csvRows = dataResult.rows.map(row => {
      return columns.map(col => {
        const val = row[col];
        if (val === null || val === undefined) return '';
        const str = String(val).replace(/"/g, '""');
        return `"${str}"`;
      }).join(',');
    });

    const csvContent = [headers, ...csvRows].join('\n');

    // Import Resend
    const { Resend } = await import('resend');
    const resend = new Resend(config.resendApiKey);

    // Send email - For now, send to verified email (Resend limitation in dev mode)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const recipientEmail = config.backupEmail;
    
    const { data, error } = await resend.emails.send({
      from: 'BedSched <onboarding@resend.dev>',
      to: [recipientEmail],
      subject: `BedSched Departures Export for ${email} - ${date} - ${timestamp}`,
      html: `
        <h2>BedSched Departures Export</h2>
        <p><strong>Note:</strong> This export was requested by <strong>${user.username}</strong> to be sent to <strong>${email}</strong></p>
        <p>Due to Resend email limitations in development mode, this is being sent to the verified email address. Please forward this to ${email} if needed.</p>
        <hr />
        <p>The departures data for <strong>${date}</strong> is attached.</p>
        <p><strong>Export Details:</strong></p>
        <ul>
          <li>Total Records: ${dataResult.rows.length}</li>
          <li>Date: ${date}</li>
          <li>Generated: ${new Date().toLocaleString()}</li>
          <li>Requested by: ${user.username}</li>
          <li>Intended recipient: ${email}</li>
        </ul>
        <p>The CSV file contains all departures for the selected date.</p>
      `,
      attachments: [
        {
          filename: `departures-${date}-${timestamp}.csv`,
          content: Buffer.from(csvContent).toString('base64')
        }
      ]
    });

    if (error) {
      console.error('[SEND_DEPARTURES_CSV] Error sending email:', error);
      return res.status(500).json({ error: 'email_send_failed', message: error.message });
    }

    await logAudit(req, 'send_departures_csv_export', 'allocations', null, { 
      requestedEmail: email,
      actualRecipient: recipientEmail,
      date,
      recordCount: dataResult.rows.length
    });

    res.json({ 
      ok: true, 
      message: `CSV sent to ${recipientEmail} (intended for ${email}). Please check your email.`,
      recordCount: dataResult.rows.length 
    });

  } catch (e) {
    console.error('Send departures CSV error:', e);
    res.status(500).json({ error: 'send_csv_failed', message: e.message });
  }
});

// GET /api/allocations/currently-occupied?page=1&limit=50&sortField=name&sortOrder=asc
app.get('/api/allocations/currently-occupied', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || !['admin', 'location_user'].includes(user.role)) return res.status(403).json({ error: 'forbidden' });

    const { page = 1, limit = 50, sortField = 'bed_number', sortOrder = 'asc', location_id = '', tent_index = '', block_index = '' } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    
    // Validate sortField to prevent SQL injection
    const allowedSortFields = ['name', 'phone', 'location_name', 'tent_index', 'block_index', 'bed_number', 'start_date', 'end_date', 'gender'];
    const validSortField = allowedSortFields.includes(sortField) ? sortField : 'bed_number';
    const validSortOrder = sortOrder?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    // Build WHERE conditions
    let whereConditions = [
      'a.deleted_at IS NULL',
      "a.status = 'confirmed'",
      `a.start_date <= ${todaySQL}`,
      `a.end_date >= ${todaySQL}`
    ];
    let params = [];
    let paramCounter = 1;

    if (location_id) {
      whereConditions.push(`a.location_id = $${paramCounter}`);
      params.push(location_id);
      paramCounter++;
    }
    if (tent_index) {
      whereConditions.push(`a.tent_index = $${paramCounter}`);
      params.push(tent_index);
      paramCounter++;
    }
    if (block_index) {
      whereConditions.push(`a.block_index = $${paramCounter}`);
      params.push(block_index);
      paramCounter++;
    }

    const whereClause = whereConditions.join(' AND ');

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total
      FROM allocations a
      WHERE ${whereClause}
    `;
    const countResult = await execQuery(countQuery, params);
    const total = Number(countResult.rows[0]?.total || 0);

    // Get paginated data
    params.push(Number(limit), offset);
    const rows = await execQuery(`
      SELECT a.id, a.phone, a.name, a.location_id, l.name as location_name, 
             a.tent_index, t.name as tent_name, a.block_index, b.name as block_name, 
             a.bed_number, a.gender, a.status, a.start_date, a.end_date
      FROM allocations a
      LEFT JOIN locations l ON a.location_id = l.id
      LEFT JOIN tents t ON a.location_id = t.location_id AND a.tent_index = t.tent_index
      LEFT JOIN blocks b ON t.id = b.tent_id AND a.block_index = b.block_index
      WHERE ${whereClause}
      ORDER BY ${validSortField === 'location_name' ? 'l.name' : 'a.' + validSortField} ${validSortOrder}
      LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
    `, params);
    
    await logAudit(req, 'view_currently_occupied', 'report', null, { count: rows.rows.length });
    res.json({ 
      ok: true, 
      items: rows.rows,
      total,
      page: Number(page),
      limit: Number(limit)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'currently_occupied_failed' });
  }
});

/* --------------------------------- Send Currently Occupied CSV via Email -------------------------------- */
app.post('/api/allocations/currently-occupied/send-csv', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || !['admin', 'location_user'].includes(user.role)) return res.status(403).json({ error: 'forbidden' });

    const { email, sortField = 'bed_number', sortOrder = 'asc', location_id = '', tent_index = '', block_index = '' } = req.body;
    
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'invalid_email', message: 'Valid email address is required' });
    }

    // Validate sortField
    const allowedSortFields = ['name', 'phone', 'location_name', 'tent_index', 'block_index', 'bed_number', 'start_date', 'end_date', 'gender'];
    const validSortField = allowedSortFields.includes(sortField) ? sortField : 'bed_number';
    const validSortOrder = sortOrder?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    // Build WHERE conditions
    let whereConditions = [
      'a.deleted_at IS NULL',
      "a.status = 'confirmed'",
      `a.start_date <= ${todaySQL}`,
      `a.end_date >= ${todaySQL}`
    ];
    let params = [];
    let paramCounter = 1;

    if (location_id) {
      whereConditions.push(`a.location_id = $${paramCounter}`);
      params.push(location_id);
      paramCounter++;
    }
    if (tent_index) {
      whereConditions.push(`a.tent_index = $${paramCounter}`);
      params.push(tent_index);
      paramCounter++;
    }
    if (block_index) {
      whereConditions.push(`a.block_index = $${paramCounter}`);
      params.push(block_index);
      paramCounter++;
    }

    const whereClause = whereConditions.join(' AND ');

    // Fetch ALL data (no pagination)
    const dataQuery = `
      SELECT 
        a.id, 
        a.phone, 
        a.name, 
        a.gender,
        a.location_id, 
        l.name as location_name, 
        a.tent_index, 
        t.name as tent_name, 
        a.block_index, 
        b.name as block_name, 
        a.bed_number, 
        a.status, 
        a.start_date, 
        a.end_date,
        a.created_at
      FROM allocations a
      LEFT JOIN locations l ON a.location_id = l.id
      LEFT JOIN tents t ON a.location_id = t.location_id AND a.tent_index = t.tent_index
      LEFT JOIN blocks b ON t.id = b.tent_id AND a.block_index = b.block_index
      WHERE ${whereClause}
      ORDER BY ${validSortField === 'location_name' ? 'l.name' : 'a.' + validSortField} ${validSortOrder}
    `;

    const dataResult = await execQuery(dataQuery, params);

    // Generate CSV
    const columns = [
      'id', 'name', 'phone', 'gender', 'location_name', 'tent_name', 'block_name', 'bed_number',
      'start_date', 'end_date', 'status', 'created_at'
    ];

    const headers = columns.join(',');
    const csvRows = dataResult.rows.map(row => {
      return columns.map(col => {
        const val = row[col];
        if (val === null || val === undefined) return '';
        const str = String(val).replace(/"/g, '""');
        return `"${str}"`;
      }).join(',');
    });

    const csvContent = [headers, ...csvRows].join('\n');

    // Import Resend
    const { Resend } = await import('resend');
    const resend = new Resend(config.resendApiKey);

    // Send email
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const recipientEmail = config.backupEmail;
    const csvBase64 = Buffer.from(csvContent, 'utf-8').toString('base64');
    
    const { data, error } = await resend.emails.send({
      from: 'BedSched <onboarding@resend.dev>',
      to: [recipientEmail],
      subject: `BedSched Currently Occupied Export for ${email} - ${timestamp}`,
      html: `
        <h2>Currently Occupied Export</h2>
        <p><strong>Intended recipient:</strong> ${email}</p>
        <p><strong>Note:</strong> Due to Resend limitations in development mode, this email was sent to the verified address.</p>
        <p><strong>Total Records:</strong> ${dataResult.rows.length}</p>
        ${location_id ? `<p><strong>Filtered by Location ID:</strong> ${location_id}</p>` : ''}
        ${tent_index ? `<p><strong>Filtered by Tent:</strong> ${tent_index}</p>` : ''}
        ${block_index ? `<p><strong>Filtered by Block:</strong> ${block_index}</p>` : ''}
        <p>The CSV file is attached to this email.</p>
      `,
      attachments: [{
        filename: `currently-occupied-${new Date().toISOString().slice(0, 10)}.csv`,
        content: csvBase64
      }]
    });

    if (error) {
      console.error('Resend error:', error);
      return res.status(500).json({ error: 'email_send_failed', message: error.message });
    }

    await logAudit(req, 'export_currently_occupied', 'allocation', null, { 
      email,
      recordCount: dataResult.rows.length
    });

    res.json({
      ok: true,
      message: 'CSV email sent successfully',
      recordCount: dataResult.rows.length,
      emailId: data?.id
    });
  } catch (e) {
    console.error('Send currently occupied CSV error:', e);
    res.status(500).json({ error: 'send_csv_failed', message: e.message });
  }
});

// GET /api/admin/trigger-backup (manual backup trigger for testing)
app.get('/api/admin/trigger-backup', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    
    const { runBackup } = await import('./common/backup.js');
    res.json({ ok: true, message: 'Backup triggered, check server logs for status' });
    
    // Run backup asynchronously (don't block response)
    runBackup().catch(err => console.error('[BACKUP] Manual backup failed:', err));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'backup_trigger_failed' });
  }
});

// GET /api/admin/analytics - Get analytics data
app.get('/api/admin/analytics', async (req, res) => {
  try {
    const user = getUserFromRequest(req);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });

    const { startDate, endDate, locationId, tentIndex, blockIndex } = req.query;

    // Build WHERE clause based on filters
    // Exclude only booking_error and no_show deallocations
    let whereConditions = [
      'a.was_occupied = true'
    ];
    let params = [];
    let paramCounter = 1;

    // Subquery to check if allocation should be excluded (no_show or booking_error)
    const exclusionSubquery = `
      AND NOT EXISTS (
        SELECT 1 FROM audit_logs al_ex
        WHERE al_ex.action = 'deallocate'
          AND al_ex.entity_type = 'allocation'
          AND al_ex.entity_id = a.id
          AND al_ex.details->>'reason' IN ('no_show', 'booking_error')
      )
    `;

    if (startDate) {
      whereConditions.push(`a.created_at >= $${paramCounter}::date`);
      params.push(startDate);
      paramCounter++;
    }

    if (endDate) {
      whereConditions.push(`a.created_at <= $${paramCounter}::date + interval '1 day'`);
      params.push(endDate);
      paramCounter++;
    }

    if (locationId) {
      whereConditions.push(`a.location_id = $${paramCounter}`);
      params.push(locationId);
      paramCounter++;
    }

    if (tentIndex) {
      whereConditions.push(`a.tent_index = $${paramCounter}`);
      params.push(tentIndex);
      paramCounter++;
    }

    if (blockIndex) {
      whereConditions.push(`a.block_index = $${paramCounter}`);
      params.push(blockIndex);
      paramCounter++;
    }

    const whereClause = whereConditions.join(' AND ');

    // 1. Total lifetime allocations (exclude booking errors and no-shows)
    const totalResult = await execQuery(`
      SELECT COUNT(*) as total
      FROM allocations a
      WHERE ${whereClause}
        ${exclusionSubquery}
    `, params);

    // 2. Gender breakdown
    const genderResult = await execQuery(`
      SELECT 
        LOWER(a.gender) as gender,
        COUNT(*) as count
      FROM allocations a
      WHERE ${whereClause}
        ${exclusionSubquery}
        AND a.gender IS NOT NULL
        AND a.gender != ''
      GROUP BY LOWER(a.gender)
    `, params);

    // 3. Daily allocations timeline
    const dailyAllocationsResult = await execQuery(`
      SELECT 
        DATE(a.created_at) as date,
        COUNT(*) as count
      FROM allocations a
      WHERE ${whereClause}
        ${exclusionSubquery}
      GROUP BY DATE(a.created_at)
      ORDER BY date
    `, params);

    // 4. Daily departures timeline
    const dailyDeparturesResult = await execQuery(`
      SELECT 
        a.end_date as date,
        COUNT(*) as count
      FROM allocations a
      WHERE ${whereClause}
        ${exclusionSubquery}
      GROUP BY a.end_date
      ORDER BY date
    `, params);

    // 5. Daily deallocations timeline by reason (from audit logs)
    // Build separate params for deallocations query to match the same filters
    let deallocParams = [];
    let deallocConditions = ['al.action = \'deallocate\'', 'al.entity_type = \'allocation\''];
    let deallocParamCounter = 1;

    if (startDate) {
      deallocConditions.push(`DATE(al.created_at) >= $${deallocParamCounter}::date`);
      deallocParams.push(startDate);
      deallocParamCounter++;
    }

    if (endDate) {
      deallocConditions.push(`DATE(al.created_at) <= $${deallocParamCounter}::date + interval '1 day'`);
      deallocParams.push(endDate);
      deallocParamCounter++;
    }

    if (locationId) {
      deallocConditions.push(`(al.details->>'locationId')::int = $${deallocParamCounter}`);
      deallocParams.push(locationId);
      deallocParamCounter++;
    }

    if (tentIndex) {
      deallocConditions.push(`(al.details->>'tentIndex')::int = $${deallocParamCounter}`);
      deallocParams.push(tentIndex);
      deallocParamCounter++;
    }

    if (blockIndex) {
      deallocConditions.push(`(al.details->>'blockIndex')::int = $${deallocParamCounter}`);
      deallocParams.push(blockIndex);
      deallocParamCounter++;
    }

    const deallocWhereClause = deallocConditions.join(' AND ');

    const dailyDeallocationsResult = await execQuery(`
      SELECT 
        DATE(al.created_at) as date,
        COALESCE(al.details->>'reason', 'not_specified') as reason,
        COUNT(*) as count
      FROM audit_logs al
      WHERE ${deallocWhereClause}
      GROUP BY DATE(al.created_at), al.details->>'reason'
      ORDER BY date, reason
    `, deallocParams);

    // 6. Allocations by user (with location info for color coding)
    // Join with audit_logs to find who created each allocation, exclude booking errors and no-shows
    const userAllocationsResult = await execQuery(`
      SELECT 
        DATE(a.created_at) as date,
        COALESCE(creator.username, 'Unknown') as username,
        creator.user_id,
        a.location_id,
        l.name as location_name,
        COUNT(*) as count
      FROM allocations a
      LEFT JOIN LATERAL (
        SELECT user_id, username
        FROM audit_logs
        WHERE entity_type = 'allocation'
          AND entity_id = a.id
          AND action IN ('allocate', 'bulk_allocate', 'smart_reserve')
        ORDER BY created_at ASC
        LIMIT 1
      ) creator ON true
      LEFT JOIN locations l ON a.location_id = l.id
      WHERE ${whereClause}
        ${exclusionSubquery}
      GROUP BY DATE(a.created_at), creator.username, creator.user_id, a.location_id, l.name
      ORDER BY date, username
    `, params);

    await logAudit(req, 'view_analytics', 'report', null, { filters: req.query });

    res.json({
      ok: true,
      data: {
        totalAllocations: parseInt(totalResult.rows[0]?.total || 0),
        genderBreakdown: genderResult.rows,
        dailyAllocations: dailyAllocationsResult.rows,
        dailyDepartures: dailyDeparturesResult.rows,
        dailyDeallocations: dailyDeallocationsResult.rows,
        userAllocations: userAllocationsResult.rows
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'analytics_failed' });
  }
});

// GET /api/allocations/reserved-active
app.get('/api/allocations/reserved-active', async (_req, res) => {
  try {
    const user = getUserFromRequest(_req);
    if (!user || !['admin', 'location_user'].includes(user.role)) return res.status(403).json({ error: 'forbidden' });
    const rows = await execQuery(`
      SELECT a.id, a.batch_id, a.phone, a.name, a.location_id, l.name as location_name, a.tent_index, a.block_index, a.bed_number, 
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

    const { photoType, locationId, tentIndex, blockIndex, key, name, bedNumber } = req.body;
    
    if (!photoType || !locationId) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    if (photoType !== 'person' && photoType !== 'aadhaar') {
      return res.status(400).json({ error: 'invalid_photo_type' });
    }

    // If frontend provides key, use it; otherwise generate one with format: {bedNumber}-{ddmmyyyy}-{hhmm}-{name}-{type}
    const photoKey = key || (() => {
      const now = new Date();
      const dd = String(now.getDate()).padStart(2, '0');
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const yyyy = now.getFullYear();
      const hh = String(now.getHours()).padStart(2, '0');
      const min = String(now.getMinutes()).padStart(2, '0');
      
      // Sanitize name for file path (remove special characters, replace spaces with hyphens)
      const sanitizedName = (name || 'unnamed').replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '-').toLowerCase();
      
      // Map photoType to desired suffix
      const typeSuffix = photoType === 'person' ? 'person' : 'identity';
      
      const bedNumPrefix = bedNumber ? `${bedNumber}-` : '';
      
      return `location-${locationId}/tent-${tentIndex || 0}/block-${blockIndex || 0}/${bedNumPrefix}${dd}${mm}${yyyy}-${hh}${min}-${sanitizedName}-${typeSuffix}.jpg`;
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
    const { name, phone, emergencyPhone, gender, startDate, endDate, personPhotoKey, aadhaarPhotoKey } = req.body;

    // Validate allocation exists and is not deleted
    const existing = await execQuery(
      'SELECT * FROM allocations WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (existing.rowCount === 0) {
      return res.status(404).json({ error: 'allocation_not_found' });
    }

    const current = existing.rows[0];

    // If gender is being updated, validate gender restrictions
    if (gender !== undefined && gender !== current.gender) {
      try {
        await validateGenderRestriction(
          current.location_id,
          current.tent_index,
          current.block_index,
          gender
        );
      } catch (e) {
        return res.status(400).json({ error: 'validation_failed', message: e.message });
      }
    }

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
    if (emergencyPhone !== undefined) {
      updates.push(`emergency_phone = $${paramIndex++}`);
      values.push(emergencyPhone || null);
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
  const locationId = Number(req.params.id);
  const tentIndex = Number(req.params.tent);
  const blockIndex = Number(req.params.block);
  const bedNumber = Number(req.params.bedNumber);
  
  try {
    console.log(`[ALLOCATE] Start - Bed ${bedNumber}`);

    const { name, phone, gender, startDate, endDate, emergencyPhone, personPhotoKey, aadhaarPhotoKey } = req.body || {};
    if (!name || !startDate || !endDate) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    // Validate photos are provided
    if (!personPhotoKey || !aadhaarPhotoKey) {
      return res.status(400).json({ error: 'photos_required', message: 'Both person and Identity photos are required' });
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
      INSERT INTO allocations(location_id, tent_id, block_id, tent_index, block_index, bed_number, name, phone, gender, start_date, end_date, emergency_phone, person_photo_key, aadhaar_photo_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING id, name, phone, gender,
                TO_CHAR(start_date, 'YYYY-MM-DD') as start_date,
                TO_CHAR(end_date, 'YYYY-MM-DD') as end_date,
                emergency_phone, person_photo_key, aadhaar_photo_key, status
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
      emergencyPhone || null,
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
      emergencyPhone: allocation.emergency_phone,
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
    
    const { name, phone, maleCount, femaleCount, startDate, endDate, emergencyPhone } = req.body || {};
    
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
        values.push(locationId, tentId, blockId, tentIndex, blockIndex, bedNumber, name, phone || null, 'Male', startDate, endDate, batchId, emergencyPhone || null);
        paramIndex += 13;
        success.push({ bedNumber, gender: 'Male', name });
      }

      // Prepare female allocations
      for (let i = 0; i < (femaleCount || 0); i++) {
        const bedNumber = availableBeds[bedIndex++];
        placeholders.push(`($${paramIndex},$${paramIndex+1},$${paramIndex+2},$${paramIndex+3},$${paramIndex+4},$${paramIndex+5},$${paramIndex+6},$${paramIndex+7},$${paramIndex+8},$${paramIndex+9},$${paramIndex+10},$${paramIndex+11},$${paramIndex+12})`);
        values.push(locationId, tentId, blockId, tentIndex, blockIndex, bedNumber, name, phone || null, 'Female', startDate, endDate, batchId, emergencyPhone || null);
        paramIndex += 13;
        success.push({ bedNumber, gender: 'Female', name });
      }

      // Execute single bulk INSERT if we have any beds to allocate
      if (placeholders.length > 0) {
        await execQuery(`
          INSERT INTO allocations(location_id, tent_id, block_id, tent_index, block_index, bed_number, name, phone, gender, start_date, end_date, batch_id, emergency_phone)
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
// body: partial { name, phone, emergencyPhone, gender, startDate, endDate, personPhotoKey, aadhaarPhotoKey }
app.patch('/api/locations/:id/tents/:tent/blocks/:block/beds/:bedNumber', async (req, res) => {
  const startTime = Date.now();
  try {
    const locationId = Number(req.params.id);
    const tentIndex = Number(req.params.tent);
    const blockIndex = Number(req.params.block);
    const bedNumber = Number(req.params.bedNumber);
    if (!Number.isFinite(bedNumber)) return res.status(400).json({ error: 'invalid_bed_number' });
    
    console.log(`[EDIT] Start - Bed ${bedNumber}`);
    
    // Validate bed exists - skip gender validation since we'll check it later if gender changes
    const t1 = Date.now();
    let blockId, tentId;
    try {
      const result = await execQuery(`
        SELECT b.id as block_id, b.size, t.id as tent_id
        FROM blocks b
        JOIN tents t ON t.id = b.tent_id
        WHERE t.location_id = $1 AND t.tent_index = $2 AND b.block_index = $3
      `, [locationId, tentIndex, blockIndex]);
      
      if (result.rowCount === 0) throw new Error('Block not found');
      const block = result.rows[0];
      
      if (bedNumber < 1 || bedNumber > block.size) throw new Error('Bed out of range');
      
      blockId = block.block_id;
      tentId = block.tent_id;
    } catch (e) {
      return res.status(400).json({ error: 'validation_failed', message: e.message });
    }
    console.log(`[EDIT] Validation: ${Date.now() - t1}ms`);

    // Find current active allocation
    const t2 = Date.now();
    const findQ = `
      SELECT id, name, phone, gender, emergency_phone,
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
    const { name, phone, gender, startDate, endDate, emergencyPhone, personPhotoKey, aadhaarPhotoKey } = req.body || {};

    // Build dynamic UPDATE query
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
    if (emergencyPhone !== undefined) {
      updates.push(`emergency_phone = $${paramIndex++}`);
      values.push(emergencyPhone || null);
    }
    if (gender !== undefined) {
      const normalizedGender = gender && gender.trim() && ['Male', 'Female', 'Other'].includes(gender.trim()) 
        ? gender.trim() 
        : 'Other';
      
      // Validate gender restriction for the block if gender is being changed
      if (normalizedGender !== current.gender) {
        try {
          await validateGenderRestriction(locationId, tentIndex, blockIndex, normalizedGender);
        } catch (e) {
          return res.status(400).json({ error: 'gender_restriction_violation', message: e.message });
        }
      }
      
      updates.push(`gender = $${paramIndex++}`);
      values.push(normalizedGender);
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

    // Always update updated_at
    updates.push(`updated_at = NOW()`);
    values.push(current.id);

    // Cleanup expired reservations (non-blocking)
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

    // UPDATE the allocation
    const t3 = Date.now();
    const updateQ = `
      UPDATE allocations
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING id, name, phone, emergency_phone, gender,
                TO_CHAR(start_date, 'YYYY-MM-DD') as start_date,
                TO_CHAR(end_date, 'YYYY-MM-DD') as end_date,
                person_photo_key, aadhaar_photo_key, status
    `;
    
    const result = await execQuery(updateQ, values);
    const updatedAllocation = result.rows[0];
    console.log(`[EDIT] UPDATE: ${Date.now() - t3}ms`);

    // Log audit in background (non-blocking)
    logAudit(req, 'edit_allocation', 'allocation', current.id, { 
      locationId, tentIndex, blockIndex, bedNumber, 
      changes: { name, phone, emergencyPhone, gender, startDate, endDate, personPhotoKey, aadhaarPhotoKey }
    });

    // Return updated data
    const response = {
      id: updatedAllocation.id,
      name: updatedAllocation.name,
      phone: updatedAllocation.phone,
      emergencyPhone: updatedAllocation.emergency_phone,
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
    const { wasOccupied, reason } = req.body || {}; // Get wasOccupied flag and reason from request body (default to empty object)
    
    const blockId = await validateBedWithinBlock(locationId, tentIndex, blockIndex, bedNumber);

    // First, get the allocation ID before deletion
    const getIdQ = `
      SELECT id FROM allocations
      WHERE block_id = $1
        AND bed_number = $2
        AND deleted_at IS NULL
        AND end_date >= ${todaySQL}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const idResult = await execQuery(getIdQ, [blockId, bedNumber]);
    if (idResult.rowCount === 0) return res.status(404).json({ error: 'no_active_allocation' });
    const allocationId = idResult.rows[0].id;

    const delQ = `
      UPDATE allocations 
      SET deleted_at = NOW(), updated_at = NOW(), was_occupied = $1
      WHERE id = $2
    `;
    const r = await execQuery(delQ, [wasOccupied !== false, allocationId]); // Default to true if not specified
    await logAudit(req, 'deallocate', 'allocation', allocationId, { locationId, tentIndex, blockIndex, bedNumber, wasOccupied: wasOccupied !== false, reason: reason || 'not_specified' });
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

/* --------------------------------- Bulk CSV Import -------------------------------- */

// Configure multer for CSV file upload (memory storage)
const csvUpload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

// POST /api/locations/:id/tents/:tent/blocks/:block/bulk-import-csv
// Upload CSV and bulk allocate to a specific block
app.post('/api/locations/:id/tents/:tent/blocks/:block/bulk-import-csv', 
  csvUpload.single('csv'), 
  async (req, res) => {
    try {
      const user = getUserFromRequest(req);
      if (!user || !['admin', 'location_user'].includes(user.role)) {
        return res.status(403).json({ error: 'forbidden' });
      }

      const locationId = Number(req.params.id);
      const tentIndex = Number(req.params.tent);
      const blockIndex = Number(req.params.block);

      if (!req.file) {
        return res.status(400).json({ error: 'no_csv_file', message: 'CSV file is required' });
      }

      // Parse CSV
      const csvContent = req.file.buffer.toString('utf-8');
      let records;
      try {
        records = parse(csvContent, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
          bom: true // Handle UTF-8 BOM
        });
      } catch (parseErr) {
        return res.status(400).json({ 
          error: 'csv_parse_failed', 
          message: 'Failed to parse CSV file: ' + parseErr.message 
        });
      }

      if (!records || records.length === 0) {
        return res.status(400).json({ error: 'empty_csv', message: 'CSV file is empty' });
      }

      // Validate block exists and get block_id, tent_id, size, and gender_restriction in one query
      const blockInfo = await execQuery(`
        SELECT b.id as block_id, b.size, b.gender_restriction, t.id as tent_id
        FROM blocks b
        JOIN tents t ON t.id = b.tent_id
        WHERE t.location_id = $1 AND t.tent_index = $2 AND b.block_index = $3
      `, [locationId, tentIndex, blockIndex]);
      
      if (!blockInfo.rows.length) {
        return res.status(404).json({ error: 'block_not_found' });
      }
      
      const { block_id: blockId, tent_id: tentId, size: blockSize, gender_restriction: genderRestriction } = blockInfo.rows[0];

      // Track results
      const results = {
        total: records.length,
        success: 0,
        failed: 0,
        errors: []
      };

      // Collect valid allocations for bulk insert
      const allocationsToInsert = [];
      const auditLogsToInsert = [];

      // Process each record and validate
      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const rowNum = i + 2; // Account for header row

        try {
          // Extract and validate fields
          const name = row['Name']?.trim();
          const gender = row['Gender']?.trim();
          const phone = row['Phone']?.trim();
          const emergencyPhone = row['Emergency Phone']?.trim() || null;
          const startDate = row['Start date']?.trim();
          const endDate = row['End date']?.trim();

          // Validate required fields
          if (!name) throw new Error('Name is required');
          if (!phone) throw new Error('Phone is required');
          if (!startDate) throw new Error('Start date is required');
          if (!endDate) throw new Error('End date is required');

          // Normalize gender
          const validGenders = ['Male', 'Female', 'Other'];
          const normalizedGender = validGenders.find(g => g.toLowerCase() === gender?.toLowerCase()) || 'Other';

          // Validate gender restriction
          if (genderRestriction === 'male_only' && normalizedGender.toLowerCase() !== 'male') {
            throw new Error('Block is male-only');
          }
          if (genderRestriction === 'female_only' && normalizedGender.toLowerCase() !== 'female') {
            throw new Error('Block is female-only');
          }

          // Add to batch for insertion
          allocationsToInsert.push({
            rowNum,
            name,
            phone,
            emergencyPhone,
            gender: normalizedGender,
            startDate,
            endDate
          });

        } catch (rowErr) {
          results.failed++;
          results.errors.push({
            row: rowNum,
            name: row['Name'],
            error: rowErr.message
          });
          console.error(`[CSV-IMPORT] Row ${rowNum} validation failed:`, rowErr.message);
        }
      }

      // If no valid records, return early
      if (allocationsToInsert.length === 0) {
        return res.json({
          ok: true,
          message: 'No valid records to import',
          results
        });
      }

      // Find available beds for all allocations
      const bedsNeeded = allocationsToInsert.length;
      const availableBedsQuery = `
        SELECT bed_num
        FROM generate_series(1, $1) AS bed_num
        WHERE bed_num NOT IN (
          SELECT bed_number 
          FROM allocations 
          WHERE block_id = $2 
            AND deleted_at IS NULL 
            AND end_date >= ${todaySQL}
            AND (status = 'confirmed' OR (status = 'reserved' AND reserved_expires_at > NOW()))
        )
        ORDER BY bed_num
        LIMIT $3
      `;
      const availableResult = await execQuery(availableBedsQuery, [blockSize, blockId, bedsNeeded]);

      if (availableResult.rows.length < bedsNeeded) {
        const shortage = bedsNeeded - availableResult.rows.length;
        return res.status(400).json({
          error: 'insufficient_beds',
          message: `Only ${availableResult.rows.length} beds available, but ${bedsNeeded} needed. ${shortage} records cannot be allocated.`,
          available: availableResult.rows.length,
          needed: bedsNeeded
        });
      }

      // Assign bed numbers
      const availableBeds = availableResult.rows.map(r => r.bed_num);
      allocationsToInsert.forEach((alloc, idx) => {
        alloc.bedNumber = availableBeds[idx];
      });

      // Bulk insert allocations
      const insertValues = allocationsToInsert.map((alloc, idx) => {
        const offset = idx * 12;
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, 'confirmed')`;
      }).join(',');

      const insertParams = allocationsToInsert.flatMap(alloc => [
        blockId,
        tentId,
        locationId,
        tentIndex,
        blockIndex,
        alloc.bedNumber,
        alloc.name,
        alloc.phone,
        alloc.emergencyPhone,
        alloc.gender,
        alloc.startDate,
        alloc.endDate
      ]);

      const bulkInsertQuery = `
        INSERT INTO allocations(
          block_id, tent_id, location_id, tent_index, block_index, bed_number,
          name, phone, emergency_phone, gender, start_date, end_date, status
        )
        VALUES ${insertValues}
        RETURNING id, bed_number, name
      `;
      
      const insertResult = await execQuery(bulkInsertQuery, insertParams);
      const insertedAllocations = insertResult.rows;

      // Prepare bulk audit logs
      const userId = user?.id || null;
      const username = user?.username || 'anonymous';
      const ipAddress = (
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
        req.headers['x-real-ip'] || 
        req.ip || 
        req.connection?.remoteAddress || 
        'unknown'
      );

      const auditValues = insertedAllocations.map((alloc, idx) => {
        const offset = idx * 7;
        const originalRow = allocationsToInsert.find(a => a.bedNumber === alloc.bed_number);
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`;
      }).join(',');

      const auditParams = insertedAllocations.flatMap((alloc, idx) => {
        const originalRow = allocationsToInsert.find(a => a.bedNumber === alloc.bed_number);
        return [
          userId,
          username,
          'allocate',
          'allocation',
          alloc.id,
          JSON.stringify({
            source: 'csv_import',
            rowNumber: originalRow.rowNum,
            name: alloc.name,
            phone: originalRow.phone,
            bedNumber: alloc.bed_number,
            locationId,
            tentIndex,
            blockIndex,
            startDate: originalRow.startDate,
            endDate: originalRow.endDate
          }),
          ipAddress
        ];
      });

      const bulkAuditQuery = `
        INSERT INTO audit_logs(user_id, username, action, entity_type, entity_id, details, ip_address)
        VALUES ${auditValues}
      `;
      
      await execQuery(bulkAuditQuery, auditParams);

      results.success = insertedAllocations.length;

      // Log overall import result
      await logAudit(req, 'bulk_csv_import', 'block', blockId, {
        locationId,
        tentIndex,
        blockIndex,
        totalRows: results.total,
        successful: results.success,
        failed: results.failed,
        filename: req.file.originalname
      });

      res.json({
        ok: true,
        message: `Import completed: ${results.success} successful, ${results.failed} failed`,
        results
      });

    } catch (e) {
      console.error('[CSV-IMPORT] Error:', e);
      res.status(500).json({ error: 'csv_import_failed', message: e.message });
    }
  }
);

