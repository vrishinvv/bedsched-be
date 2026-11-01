BEGIN;

ALTER TABLE blocks
  ADD COLUMN IF NOT EXISTS minimum_age SMALLINT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'blocks_minimum_age_check'
      AND conrelid = 'blocks'::regclass
  ) THEN
    ALTER TABLE blocks
      ADD CONSTRAINT blocks_minimum_age_check
      CHECK (minimum_age BETWEEN 0 AND 130)
      NOT VALID;
  END IF;
END $$;

ALTER TABLE blocks
  VALIDATE CONSTRAINT blocks_minimum_age_check;

COMMENT ON COLUMN blocks.minimum_age IS
  'Minimum preferred guest age for UI warnings; 0 disables age earmarking.';

COMMIT;
