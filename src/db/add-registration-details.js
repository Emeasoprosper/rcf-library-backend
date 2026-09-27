// Run once: node src/db/add-registration-details.js
import { pool } from './pool.js'

const sql = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_rcf_member BOOLEAN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS join_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS heard_from TEXT;
`
try {
  await pool.query(sql)
  console.log('✅ registration detail columns added to users.')
} catch (err) {
  console.error('❌ Failed:', err.message)
} finally {
  await pool.end()
}