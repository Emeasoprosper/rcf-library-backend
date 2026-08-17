import { pool } from './pool.js'

const sql = `
ALTER TABLE resources ADD COLUMN IF NOT EXISTS is_anonymous BOOLEAN NOT NULL DEFAULT FALSE;
`

try {
  await pool.query(sql)
  console.log('✅ is_anonymous column added.')
} catch (err) {
  console.error('❌ Failed:', err.message)
} finally {
  await pool.end()
}