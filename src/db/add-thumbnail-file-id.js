// db/add-thumbnail-file-id.js
//
// Adds a column to store the Drive file ID of the generated thumbnail
// itself (separate from the resource's own file_id). Needed because
// thumbnails now get served through our own proxy route instead of a
// raw public Drive link — see routes/resources.js GET /:id/thumbnail.

import { query, pool } from './pool.js'

async function run() {
  await query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS thumbnail_file_id TEXT`)
  console.log('✅ Added thumbnail_file_id column.')
  await pool.end()
  process.exit(0)
}

run().catch((err) => {
  console.error('❌ Failed:', err.message)
  process.exit(1)
})