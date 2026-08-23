// rcf-library-backend/src/db/backfill-resource-metadata.js
// One-time backfill: applies filename-signal detection (chapter/part/
// volume/edition) to resources uploaded before this feature existed, and
// builds same-author resource_relations across the existing library —
// same logic as the new-upload path, just run once against history
// instead of at submit time. Never overwrites a field that's already set.
import { query } from './pool.js'
import { parseFilenameSignals } from '../utils/collectionDetector.js'

async function main() {
  const resourcesResult = await query(
    `SELECT id, file_name, author, chapter, part, volume, edition FROM resources WHERE status = 'approved'`
  )

  let metadataUpdated = 0
  for (const r of resourcesResult.rows) {
    const signals = parseFilenameSignals(r.file_name)
    const chapter = r.chapter || signals.chapter
    const part = r.part || signals.part
    const volume = r.volume || signals.volume
    const edition = r.edition || signals.edition

    if (chapter !== r.chapter || part !== r.part || volume !== r.volume || edition !== r.edition) {
      await query(
        `UPDATE resources SET chapter = $1, part = $2, volume = $3, edition = $4 WHERE id = $5`,
        [chapter, part, volume, edition, r.id]
      )
      metadataUpdated++
    }
  }
  console.log(`Chapter/part/volume/edition backfilled on ${metadataUpdated} resources.`)

  let relationsCreated = 0
  const withAuthor = resourcesResult.rows.filter((r) => r.author?.trim())
  for (const r of withAuthor) {
    const sameAuthorResult = await query(
      `SELECT id FROM resources WHERE author ILIKE $1 AND id != $2 AND status = 'approved'`,
      [r.author.trim(), r.id]
    )
    for (const row of sameAuthorResult.rows) {
      const inserted = await query(
        `INSERT INTO resource_relations (resource_id, related_resource_id, relation_source)
         VALUES ($1, $2, 'author')
         ON CONFLICT DO NOTHING RETURNING resource_id`,
        [r.id, row.id]
      )
      if (inserted.rows.length > 0) relationsCreated++
    }
  }
  console.log(`${relationsCreated} author-based resource_relations created.`)

  console.log('Backfill complete.')
  process.exit(0)
}

main().catch((err) => {
  console.error('Backfill failed:', err)
  process.exit(1)
})