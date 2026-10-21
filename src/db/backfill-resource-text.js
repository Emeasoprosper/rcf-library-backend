// rcf-library-backend/src/db/backfill-resource-text.js
// Usage (from rcf-library-backend/):
//   node src/db/backfill-resource-text.js 10        -> resources with no text yet
//   node src/db/backfill-resource-text.js 10 ocr    -> retry scanned files flagged needs_ocr
// The number is how many to process this run (default 10, max 200).
// In ocr mode, files that still can't be read (too big, AI error) stay
// needs_ocr and move to the back of the queue, so repeat runs go forward.
import 'dotenv/config'
import { query } from './pool.js'
import { extractResourceText } from '../services/textExtraction.js'

const limit = Math.min(Math.max(Number(process.argv[2]) || 10, 1), 200)
const ocrMode = process.argv[3] === 'ocr'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function run() {
  const pending = ocrMode
    ? await query(
        `SELECT r.id, r.title, r.file_id, r.file_type
         FROM resources r
         JOIN resource_text t ON t.resource_id = r.id
         WHERE r.status = 'approved' AND t.status = 'needs_ocr'
         ORDER BY t.extracted_at ASC
         LIMIT $1`,
        [limit]
      )
    : await query(
        `SELECT r.id, r.title, r.file_id, r.file_type
         FROM resources r
         WHERE r.status = 'approved'
           AND NOT EXISTS (SELECT 1 FROM resource_text t WHERE t.resource_id = r.id)
         ORDER BY r.created_at ASC
         LIMIT $1`,
        [limit]
      )
  console.log(`${ocrMode ? 'Reading scanned files' : 'Extracting text'} for ${pending.rows.length} resource(s)...`)

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
    // Be gentle with the AI rate limit when OCR is involved.
    if (ocrMode) await sleep(1500)
  }
  console.log('Done:', tally)
  process.exit(0)
}

run().catch((err) => {
  console.error('Backfill failed:', err)
  process.exit(1)
})