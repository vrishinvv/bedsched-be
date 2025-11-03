-- Add location_id column to users table
-- This allows location-specific users to be restricted to their location

-- First, update the role check constraint to allow 'location_user'
ALTER TABLE users
DROP CONSTRAINT users_role_check;

ALTER TABLE users
ADD CONSTRAINT users_role_check 
CHECK (role IN ('dashboard', 'admin', 'location_user'));

-- Add location_id column
ALTER TABLE users 
ADD COLUMN location_id INT;

-- Add foreign key constraint
ALTER TABLE users
ADD CONSTRAINT fk_users_location 
FOREIGN KEY (location_id) 
REFERENCES locations(id) 
ON DELETE SET NULL;

-- Add index for faster lookups
CREATE INDEX idx_users_location_id ON users(location_id);

-- Add comment
COMMENT ON COLUMN users.location_id IS 'Location ID for location-specific users. NULL for super admins with access to all locations.';
