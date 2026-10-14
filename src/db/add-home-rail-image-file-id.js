import { pool } from './pool.js'
try {
  await pool.query('ALTER TABLE home_rails ADD COLUMN IF NOT EXISTS image_url TEXT')
  await pool.query('ALTER TABLE home_rails ADD COLUMN IF NOT EXISTS image_file_id TEXT')
  console.log('✅ image_url and image_file_id ready on home_rails.')
} catch (err) {
  console.error('❌ Failed:', err.message)
} finally {
  await pool.end()
}