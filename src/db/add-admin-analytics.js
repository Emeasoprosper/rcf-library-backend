import { pool } from './pool.js'
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS user_activity_daily (
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activity_date DATE NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, activity_date)
  )`)
  await pool.query('CREATE INDEX IF NOT EXISTS idx_user_activity_daily_date ON user_activity_daily (activity_date)')
  console.log('✅ user_activity_daily ready.')
} catch (err) {
  console.error('❌ Failed:', err.message)
} finally {
  await pool.end()
}