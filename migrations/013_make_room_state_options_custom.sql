BEGIN;

CREATE TABLE IF NOT EXISTS room_state_options (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL CHECK (btrim(name) <> '' AND char_length(btrim(name)) <= 100),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_room_state_options_normalized_name
  ON room_state_options (lower(btrim(name)));

CREATE INDEX IF NOT EXISTS idx_room_state_options_created_by
  ON room_state_options(created_by)
  WHERE created_by IS NOT NULL;

ALTER TABLE room_state_assignments
  ADD COLUMN IF NOT EXISTS option_id BIGINT REFERENCES room_state_options(id) ON DELETE CASCADE;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'room_state_assignments'
      AND column_name = 'state_code'
  ) THEN
    EXECUTE $sql$
      WITH state_names(code, name) AS (
        VALUES
          ('AP', 'Andhra Pradesh'), ('AR', 'Arunachal Pradesh'), ('AS', 'Assam'),
          ('BR', 'Bihar'), ('CG', 'Chhattisgarh'), ('GA', 'Goa'),
          ('GJ', 'Gujarat'), ('HR', 'Haryana'), ('HP', 'Himachal Pradesh'),
          ('JH', 'Jharkhand'), ('KA', 'Karnataka'), ('KL', 'Kerala'),
          ('MP', 'Madhya Pradesh'), ('MH', 'Maharashtra'), ('MN', 'Manipur'),
          ('ML', 'Meghalaya'), ('MZ', 'Mizoram'), ('NL', 'Nagaland'),
          ('OD', 'Odisha'), ('PB', 'Punjab'), ('RJ', 'Rajasthan'),
          ('SK', 'Sikkim'), ('TN', 'Tamil Nadu'), ('TS', 'Telangana'),
          ('TR', 'Tripura'), ('UP', 'Uttar Pradesh'), ('UK', 'Uttarakhand'),
          ('WB', 'West Bengal')
      )
      INSERT INTO room_state_options(name)
      SELECT DISTINCT state_names.name
      FROM room_state_assignments
      JOIN state_names ON state_names.code = room_state_assignments.state_code
      ON CONFLICT DO NOTHING
    $sql$;

    EXECUTE $sql$
      WITH state_names(code, name) AS (
        VALUES
          ('AP', 'Andhra Pradesh'), ('AR', 'Arunachal Pradesh'), ('AS', 'Assam'),
          ('BR', 'Bihar'), ('CG', 'Chhattisgarh'), ('GA', 'Goa'),
          ('GJ', 'Gujarat'), ('HR', 'Haryana'), ('HP', 'Himachal Pradesh'),
          ('JH', 'Jharkhand'), ('KA', 'Karnataka'), ('KL', 'Kerala'),
          ('MP', 'Madhya Pradesh'), ('MH', 'Maharashtra'), ('MN', 'Manipur'),
          ('ML', 'Meghalaya'), ('MZ', 'Mizoram'), ('NL', 'Nagaland'),
          ('OD', 'Odisha'), ('PB', 'Punjab'), ('RJ', 'Rajasthan'),
          ('SK', 'Sikkim'), ('TN', 'Tamil Nadu'), ('TS', 'Telangana'),
          ('TR', 'Tripura'), ('UP', 'Uttar Pradesh'), ('UK', 'Uttarakhand'),
          ('WB', 'West Bengal')
      )
      UPDATE room_state_assignments AS assignment
      SET option_id = option.id
      FROM state_names
      JOIN room_state_options AS option
        ON lower(btrim(option.name)) = lower(state_names.name)
      WHERE assignment.state_code = state_names.code
        AND assignment.option_id IS NULL
    $sql$;

    IF NOT EXISTS (SELECT 1 FROM room_state_assignments WHERE option_id IS NULL) THEN
      ALTER TABLE room_state_assignments ALTER COLUMN option_id SET NOT NULL;
      ALTER TABLE room_state_assignments DROP COLUMN state_code;
    ELSE
      RAISE EXCEPTION 'Unable to migrate every room state assignment to a custom option';
    END IF;
  END IF;
END
$migration$;

CREATE INDEX IF NOT EXISTS idx_room_state_assignments_option_id
  ON room_state_assignments(option_id);

COMMIT;
