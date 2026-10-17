import { pool } from './pool.js'
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS system_events (
    id          BIGSERIAL PRIMARY KEY,
    kind        TEXT NOT NULL,
    source      TEXT,
    message     TEXT,
    status      SMALLINT,
    user_id     UUID,
    resource_id UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
  await pool.query('CREATE INDEX IF NOT EXISTS idx_system_events_time ON system_events (created_at DESC)')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_system_events_kind_time ON system_events (kind, created_at DESC)')

  await pool.query('ALTER TABLE resource_views ADD COLUMN IF NOT EXISTS view_date DATE')
  await pool.query(`UPDATE resource_views SET view_date = (viewed_at AT TIME ZONE 'Africa/Lagos')::date WHERE view_date IS NULL`)
  await pool.query(`DELETE FROM resource_views a USING resource_views b
    WHERE a.user_id IS NOT NULL AND a.user_id = b.user_id AND a.resource_id = b.resource_id
      AND a.view_date = b.view_date AND a.id > b.id`)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_resource_views_user_day
    ON resource_views (resource_id, user_id, view_date) WHERE user_id IS NOT NULL`)
  console.log('✅ system_events and view de-duplication ready.')
} catch (err) {
  console.error('❌ Failed:', err.message)
} finally {
  await pool.end()
}