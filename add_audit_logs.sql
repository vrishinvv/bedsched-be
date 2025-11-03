-- Add audit logging table
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id BIGINT,
  details JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- Add comment for documentation
COMMENT ON TABLE audit_logs IS 'Tracks important user actions for security and compliance';
COMMENT ON COLUMN audit_logs.action IS 'Action type: allocate, edit, deallocate, confirm, bulk_allocate, batch_edit, batch_deallocate, smart_reserve, login, etc.';
COMMENT ON COLUMN audit_logs.entity_type IS 'Type of entity: allocation, reservation, batch, location, block, etc.';
COMMENT ON COLUMN audit_logs.details IS 'Additional context (JSON): affected beds, changes made, old/new values, etc.';
