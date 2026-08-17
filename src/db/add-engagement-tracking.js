// db/add-engagement-tracking.js
import { query } from './pool.js'

async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS resource_views (
      id BIGSERIAL PRIMARY KEY,
      resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      viewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_resource_views_resource ON resource_views(resource_id);`)
  await query(`CREATE INDEX IF NOT EXISTS idx_resource_views_user ON resource_views(user_id, viewed_at DESC);`)
  await query(`CREATE INDEX IF NOT EXISTS idx_resource_views_time ON resource_views(viewed_at DESC);`)

  // Denormalized counter for cheap sorting — resource_views table stays the source of truth.
  await query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0;`)

  console.log('Engagement tracking migration complete.')
  process.exit(0)
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})