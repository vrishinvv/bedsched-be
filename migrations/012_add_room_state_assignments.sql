CREATE TABLE IF NOT EXISTS room_state_assignments (
  block_id INTEGER PRIMARY KEY REFERENCES blocks(id) ON DELETE CASCADE,
  state_code TEXT NOT NULL CHECK (
    state_code IN (
      'AP', 'AR', 'AS', 'BR', 'CG', 'GA', 'GJ', 'HR', 'HP', 'JH',
      'KA', 'KL', 'MP', 'MH', 'MN', 'ML', 'MZ', 'NL', 'OD', 'PB',
      'RJ', 'SK', 'TN', 'TS', 'TR', 'UP', 'UK', 'WB'
    )
  ),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_room_state_assignments_updated_by
  ON room_state_assignments(updated_by)
  WHERE updated_by IS NOT NULL;

COMMENT ON TABLE room_state_assignments IS
  'Administrative assignment of an Indian state to a room; intentionally separate from bookings.';
