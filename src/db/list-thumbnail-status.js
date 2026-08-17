// db/list-thumbnail-status.js
//
// Read-only diagnostic: lists every resource with its thumbnail status,
// so we can see duplicates and confirm which specific rows have a null
// thumbnail_url vs. which ones are actually working.

import 'dotenv/config'
import { query, pool } from './pool.js'

async function run() {
  const result = await query(
    `SELECT id, title, status, thumbnail_status, thumbnail_url, thumbnail_file_id, created_at
     FROM resources
     ORDER BY title, created_at`
  )

  for (const row of result.rows) {
    console.log(
      `${row.title.slice(0, 40).padEnd(42)} | status=${row.status.padEnd(9)} | thumb_status=${(row.thumbnail_status || 'null').padEnd(11)} | has_url=${row.thumbnail_url ? 'YES' : 'NO '} | id=${row.id}`
    )
  }

  await pool.end()
  process.exit(0)
}

run().catch((err) => {
  console.error('❌ Failed:', err.message)
  process.exit(1)
})