-- Add was_occupied column to track if allocation was a real occupancy or booking error
-- Migration created: 2025-11-11

ALTER TABLE allocations ADD COLUMN IF NOT EXISTS was_occupied BOOLEAN DEFAULT true;

-- Set default true for all existing records (assume they were all real occupancies)
UPDATE allocations SET was_occupied = true WHERE was_occupied IS NULL;

-- Add index for faster filtering
CREATE INDEX IF NOT EXISTS idx_allocations_was_occupied ON allocations(was_occupied);

-- Verify the migration
SELECT 
  COUNT(*) as total_allocations,
  COUNT(*) FILTER (WHERE was_occupied = true) as real_occupancies,
  COUNT(*) FILTER (WHERE was_occupied = false) as booking_errors
FROM allocations;
