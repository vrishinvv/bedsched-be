const FLOOR_NAMES = Object.freeze([
  'First Floor',
  'Second Floor',
  'Third Floor',
  'Fourth Floor',
  'Fifth Floor',
]);

/**
 * Splits a large tent capacity into ~250-bed blocks (or 100-bed blocks if < 200),
 * merging any remainder < 100 into the final block.
 */
export function createTentBlocks(tentSize) {
  const blocks = [];
  let remaining = tentSize;

  while (remaining > 0) {
    if (remaining < 100) {
      if (blocks.length > 0) {
        blocks[blocks.length - 1] += remaining;
      } else {
        blocks.push(remaining);
      }
      break;
    } else if (tentSize < 200) {
      const blockSize = Math.min(100, remaining);
      blocks.push(blockSize);
      remaining -= blockSize;
    } else {
      const blockSize = Math.min(250, remaining);
      blocks.push(blockSize);
      remaining -= blockSize;
    }
  }

  return blocks;
}

function buildNewBlockAFloors() {
  const roomTemplate = [
    { name: 'Room 1', size: 160 },
    { name: 'Room 2', size: 20 },
    { name: 'Room 3', size: 20 },
    { name: 'Room 4', size: 160 },
  ];

  return FLOOR_NAMES.map((floorName) => ({
    name: floorName,
    blocks: roomTemplate.map((room) => ({
      name: room.name,
      size: room.size,
      genderRestriction: 'female_only',
      allowedCategories: ['sevadal'],
    })),
  }));
}

function buildNewBlockBFloors() {
  const firstFloorRooms = [
    { name: 'Room 0', size: 160 },
    { name: 'Room 4', size: 30 },
    { name: 'Room 5', size: 40 },
    { name: 'Room 6', size: 40 },
    { name: 'Room 7', size: 30 },
  ];

  const upperFloorRooms = [
    { name: 'Room 0', size: 30 },
    { name: 'Room 1', size: 40 },
    { name: 'Room 2', size: 40 },
    { name: 'Room 3', size: 30 },
    { name: 'Room 4', size: 30 },
    { name: 'Room 5', size: 40 },
    { name: 'Room 6', size: 40 },
    { name: 'Room 7', size: 30 },
    { name: 'Room 8', size: 20 },
    { name: 'Room 9', size: 20 },
  ];

  return FLOOR_NAMES.map((floorName, idx) => {
    const rooms = idx === 0 ? firstFloorRooms : upperFloorRooms;
    return {
      name: floorName,
      blocks: rooms.map((room) => ({
        name: room.name,
        size: room.size,
        genderRestriction: 'male_only',
        allowedCategories: ['sevadal'],
      })),
    };
  });
}

function buildSubdividedTent(tentNumber, tentSize, genderRestriction, allowedCategories) {
  const blockSizes = createTentBlocks(tentSize);
  return {
    name: `Tent ${tentNumber}`,
    blocks: blockSizes.map((size, idx) => ({
      name: `Block ${idx + 1}`,
      size,
      genderRestriction,
      allowedCategories: [...allowedCategories],
    })),
  };
}

export function buildSplits2026Plan() {
  const rawLocations = [
    {
      name: 'New Block A',
      shortcode: 'nba',
      landmark: 'New Block A',
      tents: buildNewBlockAFloors(),
    },
    {
      name: 'New Block B',
      shortcode: 'nbb',
      landmark: 'New Block B',
      tents: buildNewBlockBFloors(),
    },
    {
      name: 'Shivam Enclave',
      shortcode: 'she',
      landmark: 'West South',
      tents: [
        buildSubdividedTent(1, 1800, 'female_only', ['delegate', 'sevadal']),
        buildSubdividedTent(2, 450, 'male_only', ['sevadal']),
        buildSubdividedTent(3, 500, 'male_only', ['sevadal']),
        buildSubdividedTent(4, 2200, 'both', ['devotee']),
        buildSubdividedTent(5, 850, 'both', ['devotee']),
      ],
    },
    {
      name: 'Sundaram Enclave',
      shortcode: 'sue',
      landmark: 'West North',
      tents: [
        buildSubdividedTent(1, 950, 'female_only', ['delegate']),
        buildSubdividedTent(2, 800, 'male_only', ['sevadal']),
        buildSubdividedTent(3, 375, 'female_only', ['delegate']),
        buildSubdividedTent(4, 572, 'male_only', ['sevadal']),
        buildSubdividedTent(5, 500, 'male_only', ['sevadal']),
        buildSubdividedTent(6, 500, 'male_only', ['sevadal']),
        buildSubdividedTent(7, 800, 'male_only', ['sevadal']),
        buildSubdividedTent(8, 600, 'female_only', ['devotee']),
        buildSubdividedTent(9, 300, 'male_only', ['devotee']),
        buildSubdividedTent(10, 350, 'both', ['devotee']),
        buildSubdividedTent(11, 650, 'male_only', ['devotee']),
      ],
    },
    {
      name: 'Dharmakshetra Enclave',
      shortcode: 'de',
      landmark: 'Sai Hira Hall',
      tents: [
        buildSubdividedTent(1, 900, 'both', ['delegate']),
        buildSubdividedTent(2, 900, 'female_only', ['sevadal']),
      ],
    },
  ];

  return rawLocations.map((loc) => {
    const tents = loc.tents.map((tent, tIdx) => {
      const blocks = tent.blocks.map((block, bIdx) => ({
        blockIndex: bIdx + 1,
        name: block.name,
        size: block.size,
        genderRestriction: block.genderRestriction,
        allowedCategories: [...block.allowedCategories],
        minimumAge: block.minimumAge ?? 0,
      }));
      const tentSize = blocks.reduce((sum, b) => sum + b.size, 0);
      return {
        tentIndex: tIdx + 1,
        name: tent.name,
        size: tentSize,
        blocks,
      };
    });

    const locationCapacity = tents.reduce((sum, t) => sum + t.size, 0);
    return {
      name: loc.name,
      shortcode: loc.shortcode,
      landmark: loc.landmark,
      capacity: locationCapacity,
      tents,
    };
  });
}

/**
 * Resets and seeds the database with the 2026 accommodation splits and user accounts.
 * Expects `query` bound to an active transaction client.
 */
export async function applySplits2026(
  query,
  {
    adminAccounts = [{ username: 'admin', passwordHashOrPlain: 'admin' }],
    dashboardPasswordHashOrPlain = 'dashboard',
    usersPerLocation = 20,
    locationUserPasswordTransform = null,
  } = {}
) {
  const plan = buildSplits2026Plan();

  await query(
    'TRUNCATE TABLE audit_logs, allocations, blocks, tents, users, locations RESTART IDENTITY CASCADE'
  );

  const locationValues = plan.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
  const locationParams = plan.flatMap((loc) => [loc.name, loc.capacity]);
  const locResult = await query(
    `INSERT INTO locations(name, capacity) VALUES ${locationValues} RETURNING id, name`,
    locationParams
  );

  const locationInserts = locResult.rows.map((row, i) => ({
    ...plan[i],
    id: row.id,
  }));

  const allTentRows = [];
  for (const loc of locationInserts) {
    for (const tent of loc.tents) {
      allTentRows.push({
        locationId: loc.id,
        tentIndex: tent.tentIndex,
        name: tent.name,
        size: tent.size,
        blocks: tent.blocks,
      });
    }
  }

  const tentValues = allTentRows
    .map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`)
    .join(', ');
  const tentParams = allTentRows.flatMap((t) => [t.locationId, t.tentIndex, t.name, t.size]);
  const tentResult = await query(
    `INSERT INTO tents(location_id, tent_index, name, size)
     VALUES ${tentValues}
     RETURNING id, location_id, tent_index, name, size`,
    tentParams
  );

  const allBlockRows = [];
  for (let i = 0; i < tentResult.rows.length; i++) {
    const insertedTent = tentResult.rows[i];
    const specTent = allTentRows[i];
    for (const block of specTent.blocks) {
      allBlockRows.push({
        locationId: insertedTent.location_id,
        tentId: insertedTent.id,
        tentIndex: insertedTent.tent_index,
        blockIndex: block.blockIndex,
        name: block.name,
        size: block.size,
        genderRestriction: block.genderRestriction,
        allowedCategories: block.allowedCategories,
        minimumAge: block.minimumAge,
      });
    }
  }

  const blockValues = allBlockRows
    .map(
      (_, i) =>
        `($${i * 9 + 1}, $${i * 9 + 2}, $${i * 9 + 3}, $${i * 9 + 4}, $${i * 9 + 5}, $${i * 9 + 6}, $${i * 9 + 7}, $${i * 9 + 8}, $${i * 9 + 9})`
    )
    .join(', ');
  const blockParams = allBlockRows.flatMap((b) => [
    b.locationId,
    b.tentId,
    b.tentIndex,
    b.blockIndex,
    b.name,
    b.size,
    b.genderRestriction,
    b.allowedCategories,
    b.minimumAge,
  ]);
  await query(
    `INSERT INTO blocks(
       location_id, tent_id, tent_index, block_index, name, size,
       gender_restriction, allowed_categories, minimum_age
     ) VALUES ${blockValues}`,
    blockParams
  );

  const userValues = [];
  const userParams = [];
  let paramIdx = 1;
  const generatedLocationCredentials = [];

  for (const loc of locationInserts) {
    for (let i = 1; i <= usersPerLocation; i++) {
      const username = `${loc.shortcode}_${i}`;
      const plainPassword = username;
      const storedPassword = locationUserPasswordTransform
        ? await locationUserPasswordTransform(plainPassword)
        : plainPassword;
      userValues.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3})`);
      userParams.push(username, storedPassword, 'location_user', loc.id);
      paramIdx += 4;
      generatedLocationCredentials.push({
        location: loc.name,
        username,
        password: plainPassword,
      });
    }
  }

  if (userValues.length > 0) {
    await query(
      `INSERT INTO users(username, password, role, location_id) VALUES ${userValues.join(', ')}`,
      userParams
    );
  }

  for (const admin of adminAccounts) {
    await query(
      `INSERT INTO users(username, password, role, location_id)
       VALUES ($1, $2, 'admin', NULL)
       ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password, role = 'admin', location_id = NULL`,
      [admin.username, admin.passwordHashOrPlain]
    );
  }

  if (dashboardPasswordHashOrPlain) {
    await query(
      `INSERT INTO users(username, password, role, location_id)
       VALUES ('dashboard', $1, 'dashboard', NULL)
       ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password, role = 'dashboard', location_id = NULL`,
      [dashboardPasswordHashOrPlain]
    );
  }

  await query(`
    INSERT INTO user_location_access(user_id, location_id)
    SELECT id, location_id
    FROM users
    WHERE role = 'location_user' AND location_id IS NOT NULL
    ON CONFLICT (user_id, location_id) DO NOTHING
  `);

  const summary = await query(`
    SELECT
      l.id,
      l.name,
      l.capacity,
      COUNT(DISTINCT t.id)::int AS tent_count,
      COUNT(DISTINCT b.id)::int AS block_count
    FROM locations l
    LEFT JOIN tents t ON t.location_id = l.id
    LEFT JOIN blocks b ON b.tent_id = t.id
    GROUP BY l.id, l.name, l.capacity
    ORDER BY l.id
  `);

  return {
    locationsCreated: locationInserts.length,
    tentsCreated: allTentRows.length,
    blocksCreated: allBlockRows.length,
    totalCapacity: locationInserts.reduce((s, l) => s + l.capacity, 0),
    summary: summary.rows,
    credentials: generatedLocationCredentials,
  };
}
