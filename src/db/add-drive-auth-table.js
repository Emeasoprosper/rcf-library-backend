import { pool } from './pool.js'

const sql = `
CREATE TABLE IF NOT EXISTS google_drive_auth (
  id              SMALLINT PRIMARY KEY DEFAULT 1,
  refresh_token   TEXT NOT NULL,
  connected_email TEXT,
  connected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);
`

try {
  await pool.query(sql)
  console.log('✅ google_drive_auth table created.')
} catch (err) {
  console.error('❌ Failed:', err.message)
} finally {
  await pool.end()
}