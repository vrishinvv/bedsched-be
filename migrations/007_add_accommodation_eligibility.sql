-- Accommodation eligibility and caretaker relationships.
-- Existing blocks remain unrestricted; existing allocations remain usable as legacy devotees.

ALTER TABLE blocks
  ADD COLUMN IF NOT EXISTS allowed_categories TEXT[] NOT NULL
  DEFAULT ARRAY['delegate', 'sevadal', 'devotee']::TEXT[];

ALTER TABLE allocations
  ADD COLUMN IF NOT EXISTS accommodation_category TEXT NOT NULL DEFAULT 'devotee',
  ADD COLUMN IF NOT EXISTS category_source TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS verified_categories TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS category_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sai_connect_id TEXT,
  ADD COLUMN IF NOT EXISTS sai_lookup_identifier TEXT,
  ADD COLUMN IF NOT EXISTS caretaker_for_allocation_id BIGINT;

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
END $$;

ALTER TABLE blocks VALIDATE CONSTRAINT blocks_allowed_categories_check;
ALTER TABLE allocations VALIDATE CONSTRAINT allocations_accommodation_category_check;
ALTER TABLE allocations VALIDATE CONSTRAINT allocations_category_source_check;
ALTER TABLE allocations VALIDATE CONSTRAINT allocations_verified_categories_check;
ALTER TABLE allocations VALIDATE CONSTRAINT allocations_delegate_requires_verification_check;
ALTER TABLE allocations VALIDATE CONSTRAINT allocations_verified_category_matches_check;
ALTER TABLE allocations VALIDATE CONSTRAINT allocations_caretaker_not_self_check;
ALTER TABLE allocations VALIDATE CONSTRAINT allocations_caretaker_for_fkey;

CREATE INDEX IF NOT EXISTS idx_allocations_caretaker_for
  ON allocations(caretaker_for_allocation_id)
  WHERE caretaker_for_allocation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_allocations_one_active_caretaker
  ON allocations(caretaker_for_allocation_id)
  WHERE caretaker_for_allocation_id IS NOT NULL AND deleted_at IS NULL;

