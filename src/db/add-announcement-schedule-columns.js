import { query } from './pool.js'

// Adds scheduling columns to announcements: starts_at/ends_at (date range)
// and daily_start_time/daily_end_time (time-of-day window). All four are
// nullable — an item with none of them set has no restriction and shows
// exactly as before this migration, so existing rows are unaffected.

async function run() {
  await query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ`)
  await query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ`)
  await query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS daily_start_time TIME`)
  await query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS daily_end_time TIME`)
  console.log('✅ scheduling columns added to announcements')
  process.exit(0)
}

run().catch((err) => {
  console.error('❌ Migration failed:', err)
  process.exit(1)
})