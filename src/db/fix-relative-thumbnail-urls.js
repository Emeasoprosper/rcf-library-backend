// db/fix-relative-thumbnail-urls.js
//
// One-time repair for resources whose thumbnail_url got saved as a
// relative path (e.g. "/api/resources/.../thumbnail") before
// PUBLIC_API_BASE_URL was introduced. Rebuilds thumbnail_url as a full
// absolute URL for every resource that already has a thumbnail_file_id.
// Safe to re-run.

import 'dotenv/config'
import { query, pool } from './pool.js'

async function run() {
  const base = (process.env.PUBLIC_API_BASE_URL || '').replace(/\/$/, '')
  if (!base) {
    console.error('❌ PUBLIC_API_BASE_URL is not set in .env — aborting so nothing gets written incorrectly.')
    process.exit(1)
  }

  const result = await query(
    `UPDATE resources
     SET thumbnail_url = $1 || '/api/resources/' || id || '/thumbnail'
     WHERE thumbnail_file_id IS NOT NULL`,
    [base]
  )

  console.log(`✅ Fixed ${result.rowCount} thumbnail URL(s) to use ${base}`)
  await pool.end()
  process.exit(0)
}

run().catch((err) => {
  console.error('❌ Failed:', err.message)
  process.exit(1)
})