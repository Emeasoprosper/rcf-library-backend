// RCFMOUAULIBRARYreact/rcf-library-backend/src/db/add-resource-shares-table.js
// Run once: node src/db/add-resource-shares-table.js
import { query } from './pool.js'

async function run() {
  await query(`
    CREATE TABLE IF NOT EXISTS resource_shares (
      id SERIAL PRIMARY KEY,
      resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      created_by UUID REFERENCES users(id),
      click_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (resource_id)
    )
  `)

  await query(`CREATE INDEX IF NOT EXISTS idx_resource_shares_token ON resource_shares (token)`)

  console.log('✅ resource_shares table ready')
  process.exit(0)
}

run().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})