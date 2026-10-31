// RCFMOUAULIBRARYreact/rcf-library-backend/src/db/add-daily-push-log.js
// Run once: node src/db/add-daily-push-log.js
// One row per Lagos day once the "verse of the day" push has gone out, so a
// restart (or a second server) can never send it twice.
import { query } from './pool.js'

async function run() {
  await query(`
    CREATE TABLE IF NOT EXISTS daily_push_log (
      day      DATE PRIMARY KEY,
      kind     TEXT NOT NULL DEFAULT 'verse',
      sent_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
  console.log('✅ daily_push_log ready')
  process.exit(0)
}

run().catch((err) => {
  console.error('❌ Migration failed:', err)
  process.exit(1)
})
