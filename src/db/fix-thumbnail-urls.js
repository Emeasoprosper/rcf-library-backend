import { pool } from './pool.js'

const sql = `
  UPDATE resources
  SET thumbnail_url = 'https://drive.google.com/thumbnail?id=' || file_id || '&sz=w1000'
  WHERE thumbnail_url LIKE '%uc?id=%'
`

try {
  const result = await pool.query(sql)
  console.log(`✅ Fixed ${result.rowCount} thumbnail URL(s).`)
} catch (err) {
  console.error('❌ Failed:', err.message)
} finally {
  await pool.end()
}