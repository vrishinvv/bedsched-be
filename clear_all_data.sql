-- Clear ALL data from the database (including users)
-- Run this to reset to empty state before seeding

-- Disable foreign key checks temporarily
SET session_replication_role = replica;

-- Clear all tables in reverse dependency order
TRUNCATE TABLE audit_logs CASCADE;
TRUNCATE TABLE allocations CASCADE;
TRUNCATE TABLE blocks CASCADE;
TRUNCATE TABLE tents CASCADE;
TRUNCATE TABLE users CASCADE;
TRUNCATE TABLE locations CASCADE;

-- Re-enable foreign key checks
SET session_replication_role = DEFAULT;

-- Reset sequences
ALTER SEQUENCE users_id_seq RESTART WITH 1;
ALTER SEQUENCE locations_id_seq RESTART WITH 1;
ALTER SEQUENCE tents_id_seq RESTART WITH 1;
ALTER SEQUENCE blocks_id_seq RESTART WITH 1;
ALTER SEQUENCE allocations_id_seq RESTART WITH 1;
ALTER SEQUENCE audit_logs_id_seq RESTART WITH 1;

SELECT 'All data cleared successfully!' as status;
