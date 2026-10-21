// rcf-library-backend/src/db/backfill-resource-text.js
// Usage (from rcf-library-backend/):  node src/db/backfill-resource-text.js 10
// Extracts text for approved resources that have none yet. The number is
// how many to process this run (default 10, max 200).
import 'dotenv/config'
import { query } from './pool.js'
import { extractResourceText } from '../services/textExtraction.js'

const limit = Math.min(Math.max(Number(process.argv[2]) || 10, 1), 200)

async function run() {
  const pending = await query(
    `SELECT r.id, r.title, r.file_id, r.file_type
     FROM resources r
     WHERE r.status = 'approved'
       AND NOT EXISTS (SELECT 1 FROM resource_text t WHERE t.resource_id = r.id)
     ORDER BY r.created_at ASC
     LIMIT $1`,
    [limit]
  )
  console.log(`Extracting text for ${pending.rows.length} resource(s)...`)

  const tally = {}
  for (const row of pending.rows) {
    try {
      const status = await extractResourceText(row)
      tally[status] = (tally[status] || 0) + 1
      console.log(`  ${status.padEnd(12)} ${row.title}`)
    } catch (err) {
      tally.error = (tally.error || 0) + 1
      console.error(`  error        ${row.title}: ${err.message}`)
    }
  }
  console.log('Done:', tally)
  process.exit(0)
}

run().catch((err) => {
  console.error('Backfill failed:', err)
  process.exit(1)
})