/**
 * Idempotent schema migration guard for migrations 007–010 so deploying
 * the 2026 accommodation-eligibility release to an older Neon database
 * never fails with missing-column errors during cutover.
 */
const IDEMPOTENT_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS user_location_access (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_user_location_access_location_id
  ON user_location_access(location_id);

INSERT INTO user_location_access(user_id, location_id)
SELECT id, location_id
FROM users
WHERE role = 'location_user' AND location_id IS NOT NULL
ON CONFLICT (user_id, location_id) DO NOTHING;

ALTER TABLE blocks
  ADD COLUMN IF NOT EXISTS allowed_categories TEXT[] NOT NULL
  DEFAULT ARRAY['delegate', 'sevadal', 'devotee']::TEXT[];

ALTER TABLE blocks
  ADD COLUMN IF NOT EXISTS minimum_age SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE allocations
  ADD COLUMN IF NOT EXISTS accommodation_category TEXT NOT NULL DEFAULT 'devotee',
  ADD COLUMN IF NOT EXISTS category_source TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS verified_categories TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS category_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sai_connect_id TEXT,
  ADD COLUMN IF NOT EXISTS sai_lookup_identifier TEXT,
  ADD COLUMN IF NOT EXISTS caretaker_for_allocation_id BIGINT,
  ADD COLUMN IF NOT EXISTS sai_connect_age SMALLINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'blocks_allowed_categories_check'
      AND conrelid = 'blocks'::regclass
  ) THEN
    ALTER TABLE blocks
      ADD CONSTRAINT blocks_allowed_categories_check
      CHECK (
        cardinality(allowed_categories) > 0
        AND allowed_categories <@ ARRAY['delegate', 'sevadal', 'devotee']::TEXT[]
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'blocks_minimum_age_check'
      AND conrelid = 'blocks'::regclass
  ) THEN
    ALTER TABLE blocks
      ADD CONSTRAINT blocks_minimum_age_check
      CHECK (minimum_age BETWEEN 0 AND 130)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'allocations_accommodation_category_check'
      AND conrelid = 'allocations'::regclass
  ) THEN
    ALTER TABLE allocations
      ADD CONSTRAINT allocations_accommodation_category_check
      CHECK (accommodation_category IN ('delegate', 'sevadal', 'devotee')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'allocations_category_source_check'
      AND conrelid = 'allocations'::regclass
  ) THEN
    ALTER TABLE allocations
      ADD CONSTRAINT allocations_category_source_check
      CHECK (category_source IN ('sai_connect', 'manual', 'default', 'legacy')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'allocations_verified_categories_check'
      AND conrelid = 'allocations'::regclass
  ) THEN
    ALTER TABLE allocations
      ADD CONSTRAINT allocations_verified_categories_check
      CHECK (verified_categories <@ ARRAY['delegate', 'sevadal']::TEXT[]) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'allocations_delegate_requires_verification_check'
      AND conrelid = 'allocations'::regclass
  ) THEN
    ALTER TABLE allocations
      ADD CONSTRAINT allocations_delegate_requires_verification_check
      CHECK (
        accommodation_category <> 'delegate'
        OR (
          category_source = 'sai_connect'
          AND 'delegate' = ANY(verified_categories)
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'allocations_verified_category_matches_check'
      AND conrelid = 'allocations'::regclass
  ) THEN
    ALTER TABLE allocations
      ADD CONSTRAINT allocations_verified_category_matches_check
      CHECK (
        category_source <> 'sai_connect'
        OR accommodation_category = ANY(verified_categories)
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'allocations_caretaker_not_self_check'
      AND conrelid = 'allocations'::regclass
  ) THEN
    ALTER TABLE allocations
      ADD CONSTRAINT allocations_caretaker_not_self_check
      CHECK (caretaker_for_allocation_id IS NULL OR caretaker_for_allocation_id <> id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'allocations_caretaker_for_fkey'
      AND conrelid = 'allocations'::regclass
  ) THEN
    ALTER TABLE allocations
      ADD CONSTRAINT allocations_caretaker_for_fkey
      FOREIGN KEY (caretaker_for_allocation_id)
      REFERENCES allocations(id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'allocations_sai_connect_age_check'
      AND conrelid = 'allocations'::regclass
  ) THEN
    ALTER TABLE allocations
      ADD CONSTRAINT allocations_sai_connect_age_check
      CHECK (sai_connect_age IS NULL OR sai_connect_age BETWEEN 0 AND 130)
      NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_allocations_caretaker_for
  ON allocations(caretaker_for_allocation_id)
  WHERE caretaker_for_allocation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_allocations_one_active_caretaker
  ON allocations(caretaker_for_allocation_id)
  WHERE caretaker_for_allocation_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_allocations_active_sai_connect_id
  ON allocations(sai_connect_id)
  WHERE sai_connect_id IS NOT NULL
    AND category_verified_at IS NOT NULL
    AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_allocations_active_sai_lookup_identifier
  ON allocations(sai_lookup_identifier)
  WHERE sai_lookup_identifier IS NOT NULL
    AND category_verified_at IS NOT NULL
    AND deleted_at IS NULL;
`;

let migrationPromise = null;

export function ensureSchemaMigrations(pool) {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      try {
        const check = await pool.query(`
          SELECT COUNT(*)::int AS cnt
          FROM information_schema.columns
          WHERE (table_name = 'blocks' AND column_name IN ('allowed_categories', 'minimum_age'))
             OR (table_name = 'allocations' AND column_name IN ('accommodation_category', 'sai_connect_id', 'sai_connect_age', 'caretaker_for_allocation_id'))
        `);
        const accessTable = await pool.query(`
          SELECT to_regclass('public.user_location_access') IS NOT NULL AS exists
        `);
        if (check.rows[0]?.cnt === 6 && accessTable.rows[0]?.exists) {
          return true;
        }
        console.log('[DB] Applying idempotent schema migrations (007-011)...');
        await pool.query(IDEMPOTENT_MIGRATION_SQL);
        console.log('[DB] Idempotent schema migrations applied successfully');
        return true;
      } catch (err) {
        migrationPromise = null;
        console.error('[DB] Schema migration check failed:', err.message);
        throw err;
      }
    })();
  }
  return migrationPromise;
}

export { IDEMPOTENT_MIGRATION_SQL };
