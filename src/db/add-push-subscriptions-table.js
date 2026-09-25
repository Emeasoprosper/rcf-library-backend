// RCFMOUAULIBRARYreact/rcf-library-backend/src/db/add-push-subscriptions-table.js
// Run once: node src/db/add-push-subscriptions-table.js
import { pool } from './pool.js'

const sql = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint      TEXT NOT NULL UNIQUE,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);
`

try {
  await pool.query(sql)
  console.log('✅ push_subscriptions table created.')
} catch (err) {
  console.error('❌ Failed:', err.message)
} finally {
  await pool.end()
}