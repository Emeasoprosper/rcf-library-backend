// RCFMOUAULIBRARYreact/rcf-library-backend/src/db/add-announcement-popup-fields.js
// Run once: node src/db/add-announcement-popup-fields.js
import { query } from './pool.js'

async function run() {
  await query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS popup_style TEXT NOT NULL DEFAULT 'rich'`)
  await query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS hidden_detail TEXT`)
  await query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS link_url TEXT`)
  await query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS attachment_mime TEXT`)
  console.log('✅ popup fields added to announcements (popup_style, hidden_detail, link_url, attachment_mime)')
  process.exit(0)
}

run().catch((err) => {
  console.error('❌ Migration failed:', err)
  process.exit(1)
})