// RCFMOUAULIBRARYreact/rcf-library-backend/src/db/add-home-rails-table.js
// Run once: node src/db/add-home-rails-table.js
import { pool } from './pool.js'

const sql = `
CREATE TABLE IF NOT EXISTS home_rails (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS home_rail_items (
  rail_id      UUID NOT NULL REFERENCES home_rails(id) ON DELETE CASCADE,
  resource_id  UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (rail_id, resource_id)
);
`

try {
  await pool.query(sql)
  console.log('✅ home_rails and home_rail_items tables created.')
} catch (err) {
  console.error('❌ Failed:', err.message)
} finally {
  await pool.end()
}