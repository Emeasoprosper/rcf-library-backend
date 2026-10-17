import { pool } from './pool.js'
try {
  await pool.query('ALTER TABLE announcements ADD COLUMN IF NOT EXISTS music_file_id TEXT')
  await pool.query('ALTER TABLE announcements ADD COLUMN IF NOT EXISTS music_mime TEXT')
  await pool.query('ALTER TABLE announcements ADD COLUMN IF NOT EXISTS music_loop BOOLEAN NOT NULL DEFAULT TRUE')
  console.log('✅ announcement music columns ready.')
} catch (err) {
  console.error('❌ Failed:', err.message)
} finally {
  await pool.end()
}