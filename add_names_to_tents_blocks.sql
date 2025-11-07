-- Add name columns to tents and blocks tables
ALTER TABLE tents ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS name TEXT;

-- Add indexes for name lookups
CREATE INDEX IF NOT EXISTS idx_tents_name ON tents(name);
CREATE INDEX IF NOT EXISTS idx_blocks_name ON blocks(name);
