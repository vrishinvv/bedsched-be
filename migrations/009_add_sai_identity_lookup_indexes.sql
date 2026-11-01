BEGIN;

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

COMMIT;
