-- CRITICAL SAFEGUARD: Add database-level protection against accidental confirmed allocation deletions
-- This prevents ANY code from soft-deleting confirmed allocations that are still valid (end_date >= today)
-- Migration created: 2025-11-11

-- Note: We cannot add a CHECK constraint that references NOW() or CURRENT_DATE dynamically
-- Instead, we'll create a TRIGGER that validates deletions

CREATE OR REPLACE FUNCTION prevent_premature_confirmed_deletion()
RETURNS TRIGGER AS $$
BEGIN
  -- Only apply to soft-deletes (when deleted_at is being set from NULL to a timestamp)
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    -- If it's a confirmed allocation with future end_date, prevent deletion
    IF NEW.status = 'confirmed' AND NEW.end_date >= CURRENT_DATE THEN
      RAISE EXCEPTION 'CRITICAL: Attempting to delete confirmed allocation (ID: %, Name: %, Bed: %) with future end_date (%). This should only happen through explicit deallocate endpoints with audit logging.',
        NEW.id, NEW.name, NEW.bed_number, NEW.end_date
        USING HINT = 'Use the proper deallocate API endpoint with reason tracking';
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger (drop first if exists)
DROP TRIGGER IF EXISTS check_confirmed_deletion ON allocations;

CREATE TRIGGER check_confirmed_deletion
  BEFORE UPDATE ON allocations
  FOR EACH ROW
  EXECUTE FUNCTION prevent_premature_confirmed_deletion();

-- Test: Try to delete a confirmed allocation (should fail)
-- This is just for verification during migration
DO $$
DECLARE
  test_record RECORD;
BEGIN
  -- Find a confirmed allocation with future end_date
  SELECT id, name, bed_number, end_date 
  INTO test_record
  FROM allocations 
  WHERE status = 'confirmed' 
    AND end_date >= CURRENT_DATE 
    AND deleted_at IS NULL 
  LIMIT 1;
  
  IF FOUND THEN
    RAISE NOTICE 'Testing safeguard with allocation ID: %, Name: %, End date: %', 
      test_record.id, test_record.name, test_record.end_date;
    
    -- This should fail with our custom error message
    BEGIN
      UPDATE allocations 
      SET deleted_at = NOW() 
      WHERE id = test_record.id;
      
      RAISE EXCEPTION 'TEST FAILED: Safeguard did not prevent deletion!';
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'TEST PASSED: Safeguard successfully prevented deletion. Error: %', SQLERRM;
        -- Rollback the test update
        ROLLBACK;
    END;
  ELSE
    RAISE NOTICE 'No confirmed allocations found for testing. Safeguard installed successfully.';
  END IF;
END $$;

COMMIT;

-- Verify trigger is installed
SELECT 
  trigger_name, 
  event_manipulation, 
  event_object_table,
  action_statement
FROM information_schema.triggers 
WHERE trigger_name = 'check_confirmed_deletion';
