// RCFMOUAULIBRARYreact/rcf-library-backend/src/db/add-review-lock-columns.js
// Run once: node src/db/add-review-lock-columns.js
import { query } from './pool.js'

async function run() {
  await query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS reviewing_by UUID REFERENCES users(id)`)
  await query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS reviewing_started_at TIMESTAMPTZ`)
  console.log('✅ review-lock columns added to resources (reviewing_by, reviewing_started_at)')
  process.exit(0)
}

run().catch((err) => {
  console.error('❌ Migration failed:', err)
  process.exit(1)
})