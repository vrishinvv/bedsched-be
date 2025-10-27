-- Enable needed extension for exclusion constraints on ranges
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Locations (top level)
CREATE TABLE IF NOT EXISTS locations (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  capacity     INTEGER NOT NULL CHECK (capacity >= 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tents (belong to locations)
CREATE TABLE IF NOT EXISTS tents (
  id                SERIAL PRIMARY KEY,
  location_id       INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  tent_index        INTEGER NOT NULL CHECK (tent_index >= 1),
  size              INTEGER NOT NULL CHECK (size >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(location_id, tent_index)
);

-- Blocks (belong to tents)
CREATE TABLE IF NOT EXISTS blocks (
  id           SERIAL PRIMARY KEY,
  location_id  INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  tent_id      INTEGER NOT NULL REFERENCES tents(id) ON DELETE CASCADE,
  tent_index   INTEGER NOT NULL,
  block_index  INTEGER NOT NULL CHECK (block_index >= 1),
  size         INTEGER NOT NULL CHECK (size >= 0),
  gender_restriction TEXT NOT NULL DEFAULT 'both' CHECK (gender_restriction IN ('male_only', 'female_only', 'both')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tent_id, block_index)
);

-- Modified allocations table (now references blocks)
CREATE TABLE IF NOT EXISTS allocations (
  id           BIGSERIAL PRIMARY KEY,
  location_id  INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  tent_id      INTEGER NOT NULL REFERENCES tents(id) ON DELETE CASCADE,
  block_id     INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  tent_index   INTEGER NOT NULL,
  block_index  INTEGER NOT NULL,
  bed_number   INTEGER NOT NULL CHECK (bed_number >= 1),
  -- guest details
  name         TEXT NOT NULL,
  phone        TEXT,
  gender       TEXT CHECK (gender IN ('Male','Female','Other') OR gender IS NULL),
  start_date   DATE NOT NULL,
  end_date     DATE NOT NULL,
  -- reservation/confirmation lifecycle
  status       TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('reserved','confirmed','cancelled')),
  batch_id     TEXT,
  contact_name TEXT,
  is_family    BOOLEAN NOT NULL DEFAULT FALSE,
  reserved_expires_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ DEFAULT NULL,
  -- Prevent end before start
  CHECK (end_date >= start_date),
  -- Prevent overlapping bookings for same (location, tent, block, bed) - only for non-deleted records
  EXCLUDE USING gist (
    location_id WITH =,
    tent_id     WITH =,
    block_id    WITH =,
    bed_number  WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (deleted_at IS NULL)
);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_tents_location ON tents(location_id);
CREATE INDEX IF NOT EXISTS idx_blocks_tent ON blocks(tent_id);
CREATE INDEX IF NOT EXISTS idx_blocks_location ON blocks(location_id);
CREATE INDEX IF NOT EXISTS idx_allocations_location ON allocations(location_id);
CREATE INDEX IF NOT EXISTS idx_allocations_tent ON allocations(tent_id);
CREATE INDEX IF NOT EXISTS idx_allocations_block ON allocations(block_id);
CREATE INDEX IF NOT EXISTS idx_allocations_end_date ON allocations(end_date);
CREATE INDEX IF NOT EXISTS idx_allocations_status_expiry ON allocations(status, reserved_expires_at);
CREATE INDEX IF NOT EXISTS idx_allocations_batch_id ON allocations(batch_id);
CREATE INDEX IF NOT EXISTS idx_allocations_phone ON allocations(phone);

-- Users (simple auth)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('dashboard','admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed two basic users (idempotent)
INSERT INTO users(username, password, role)
VALUES ('admin', 'admin', 'admin')
ON CONFLICT (username) DO NOTHING;

INSERT INTO users(username, password, role)
VALUES ('dashboard', 'dashboard', 'dashboard')
ON CONFLICT (username) DO NOTHING;