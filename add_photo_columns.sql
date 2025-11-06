-- Migration: Add photo storage columns to allocations table
-- Date: 2025-11-06

-- Add columns for storing S3 object keys for person and Aadhaar photos
ALTER TABLE allocations 
  ADD COLUMN person_photo_key TEXT,
  ADD COLUMN aadhaar_photo_key TEXT;

-- Add comments for documentation
COMMENT ON COLUMN allocations.person_photo_key IS 'S3 object key for person photo (e.g., location-1/tent-1/block-1/timestamp-uuid-person.jpg)';
COMMENT ON COLUMN allocations.aadhaar_photo_key IS 'S3 object key for Aadhaar card photo (e.g., location-1/tent-1/block-1/timestamp-uuid-aadhaar.jpg)';
