-- Query plan analysis for slow queries

-- 1. Check the validation query plan
EXPLAIN ANALYZE
SELECT b.id as block_id, b.size, b.gender_restriction, t.id as tent_id
FROM blocks b
JOIN tents t ON t.id = b.tent_id
WHERE t.location_id = 1 AND t.tent_index = 1 AND b.block_index = 1;

-- 2. Check the existing allocation query plan (this is the 3.9 second one!)
EXPLAIN ANALYZE
SELECT id FROM allocations
WHERE block_id = (SELECT id FROM blocks WHERE tent_id = (SELECT id FROM tents WHERE location_id = 1 AND tent_index = 1) AND block_index = 1)
  AND bed_number = 179
  AND deleted_at IS NULL
  AND end_date >= CURRENT_DATE
  AND (status = 'confirmed' OR (status = 'reserved' AND reserved_expires_at > NOW()))
LIMIT 1;

-- 3. Show all indexes on allocations table
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename = 'allocations';

-- 4. Show all indexes on blocks table
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename = 'blocks';

-- 5. Show table sizes
SELECT 
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
  pg_total_relation_size(schemaname||'.'||tablename) as bytes
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY bytes DESC;
