// RCFMOUAULIBRARYreact/rcf-library-backend/src/db/add-weekly-goal.js
// Run once: node src/db/add-weekly-goal.js
// Each student's weekly reading goal (number of different resources to
// open Monday to Sunday). Streaks and badges are worked out from the
// existing resource_views / downloads / bookmarks tables, so nothing else
// needs storing.
import { query } from './pool.js'

async function run() {
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_goal SMALLINT NOT NULL DEFAULT 5`)
  await query(`CREATE INDEX IF NOT EXISTS idx_resource_views_user_date ON resource_views (user_id, view_date) WHERE user_id IS NOT NULL`)
  console.log('✅ weekly_goal added to users (default 5)')
  process.exit(0)
}

run().catch((err) => {
  console.error('❌ Migration failed:', err)
  process.exit(1)
})
