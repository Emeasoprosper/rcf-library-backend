// db/add-notification-preview.js
import { query } from './pool.js'

async function migrate() {
  await query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;`)
  await query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS resource_id UUID REFERENCES resources(id) ON DELETE SET NULL;`)
  console.log('Notification preview migration complete.')
  process.exit(0)
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})