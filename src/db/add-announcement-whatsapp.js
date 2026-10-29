// RCFMOUAULIBRARYreact/rcf-library-backend/src/db/add-announcement-whatsapp.js
// Run once: node src/db/add-announcement-whatsapp.js
// Lets admins choose per announcement whether the WhatsApp bot (Bro Paul)
// also posts it in the group, and optionally repeats it (adverts).
import { query } from './pool.js'

async function run() {
  await query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS post_to_whatsapp BOOLEAN NOT NULL DEFAULT FALSE`)
  await query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS whatsapp_repeat_hours INTEGER`)
  await query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS whatsapp_posted_at TIMESTAMPTZ`)
  console.log('✅ whatsapp fields added to announcements (post_to_whatsapp, whatsapp_repeat_hours, whatsapp_posted_at)')
  process.exit(0)
}

run().catch((err) => {
  console.error('❌ Migration failed:', err)
  process.exit(1)
})
