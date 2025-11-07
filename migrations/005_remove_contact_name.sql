-- Migration 005: Remove contact_name column
-- The contact_name field is unused; departures should use the person's actual name instead

-- Drop the contact_name column from allocations table
ALTER TABLE allocations DROP COLUMN IF EXISTS contact_name;
