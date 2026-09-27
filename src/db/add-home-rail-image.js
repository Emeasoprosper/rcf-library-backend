import { pool } from './pool.js'
try {
  await pool.query('ALTER TABLE home_rails ADD COLUMN IF NOT EXISTS image_url TEXT')
  console.log('✅ image_url added to home_rails.')
} catch (err) {
  console.error('❌ Failed:', err.message)
} finally {
  await pool.end()
}