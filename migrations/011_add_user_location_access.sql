-- Allow a location user to be assigned to more than one location while
-- preserving users.location_id for backwards compatibility and display.
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

COMMENT ON TABLE user_location_access IS
  'Locations a location_user may access. Multiple rows enable shared directional accounts.';
