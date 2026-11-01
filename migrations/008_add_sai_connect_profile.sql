BEGIN;

ALTER TABLE allocations
  ADD COLUMN IF NOT EXISTS sai_connect_age SMALLINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'allocations_sai_connect_age_check'
      AND conrelid = 'allocations'::regclass
  ) THEN
    ALTER TABLE allocations
      ADD CONSTRAINT allocations_sai_connect_age_check
      CHECK (sai_connect_age IS NULL OR sai_connect_age BETWEEN 0 AND 130)
      NOT VALID;
  END IF;
END $$;

ALTER TABLE allocations
  VALIDATE CONSTRAINT allocations_sai_connect_age_check;

COMMENT ON COLUMN allocations.sai_connect_age IS
  'Age returned by Sai Connect at verification time; null for unverified/legacy bookings.';

COMMIT;
