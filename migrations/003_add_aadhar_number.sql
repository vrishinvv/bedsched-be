-- Add aadhar_number column to allocations table
ALTER TABLE allocations ADD COLUMN aadhar_number VARCHAR(12);

-- Add comment
COMMENT ON COLUMN allocations.aadhar_number IS 'Optional 12-digit Aadhar number (stored without spaces)';
