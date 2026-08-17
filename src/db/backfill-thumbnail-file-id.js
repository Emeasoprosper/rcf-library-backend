// db/backfill-thumbnail-file-id.js
//
// One-time repair for resources uploaded before thumbnail_file_id existed.
// Re-queues preview generation for anything whose thumbnail never
// resolved to a working proxy URL. Safe to re-run — it only touches rows
// where thumbnail_file_id is still null.

import { query, pool } from './pool.js'
import { downloadFromStorage } from '../services/storage.js'
import { queuePreviewGeneration } from '../services/previewQueue.js'

async function run() {
  const { rows } = await query(
    `SELECT id, file_id, file_type FROM resources WHERE thumbnail_file_id IS NULL`
  )

  console.log(`Found ${rows.length} resource(s) needing a thumbnail repair.`)

  for (const row of rows) {
    try {
      const buffer = await downloadFromStorage(row.file_id)
      console.log(`Re-queuing preview for resource ${row.id} (${row.file_type})...`)
      await new Promise((resolve) => {
        queuePreviewGeneration(row.id, { fileId: row.file_id }, row.file_type, buffer)
        // Fire-and-forget in previewQueue.js — small delay so logs from
        // each resource don't interleave when running this in bulk.
        setTimeout(resolve, 2000)
      })
    } catch (err) {
      console.error(`Failed to repair resource ${row.id}:`, err.message)
    }
  }

  await pool.end()
  console.log('✅ Backfill complete.')
  process.exit(0)
}

run().catch((err) => {
  console.error('❌ Backfill script failed:', err.message)
  process.exit(1)
})