import { pool } from './pool.js'
try {
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_users_last_seen_at ON users (last_seen_at)')
  await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
  console.log('✅ users.last_seen_at and app_settings ready.')
} catch (err) {
  console.error('❌ Failed:', err.message)
} finally {
  await pool.end()
}