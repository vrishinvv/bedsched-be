-- Migration: Replace aadhaar_number with emergency_phone
-- Run this manually with psql

BEGIN;

-- Drop aadhaar_number column from allocations table
ALTER TABLE allocations 
DROP COLUMN IF EXISTS aadhaar_number;

-- Add emergency_phone column (optional, same format as phone field)
ALTER TABLE allocations 
ADD COLUMN emergency_phone TEXT;

-- Add comment
COMMENT ON COLUMN allocations.emergency_phone IS 'Optional emergency contact phone number';

COMMIT;

-- Verify changes
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'allocations' 
AND column_name IN ('phone', 'emergency_phone')
ORDER BY ordinal_position;

