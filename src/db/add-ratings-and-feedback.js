// Run once: node src/db/add-ratings-and-feedback.js
import { pool } from './pool.js'

const sql = `
CREATE TABLE IF NOT EXISTS app_ratings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stars       SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_feedback (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'feedback',
  message     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`
try {
  await pool.query(sql)
  console.log('✅ app_ratings and app_feedback tables created.')
} catch (err) {
  console.error('❌ Failed:', err.message)
} finally {
  await pool.end()
}