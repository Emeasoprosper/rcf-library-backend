// rcf-library-backend/src/db/backfill-collection-detection.js
//
// One-time backfill: runs the exact same deterministic detection as
// collectionDetector.js (used for new uploads) against every already-
// approved resource that has no collection assigned yet, using the
// filename stored at upload time (resources.file_name).
//
// Safety rule, matching collectionDetector.js's own confidence bands:
// only HIGH-confidence collection matches get auto-assigned here.
// Everything else (no match, or a low-confidence guess) is left alone
// and printed to a report instead — those need a human to confirm via
// the admin assignment screen. This script never guesses its way into
// wrong data; it only applies what's already reliably detectable.
import { query } from './pool.js'
import { parseFilenameSignals } from '../utils/collectionDetector.js'

const HIGH_CONFIDENCE_THRESHOLD = 0.6

async function matchCollection(titleGuess) {
  if (!titleGuess) return null
  const result = await query(
    `SELECT id, title, similarity(title, $1) AS score
     FROM resource_collections ORDER BY score DESC LIMIT 1`,
    [titleGuess]
  )
  const top = result.rows[0]
  if (!top || Number(top.score) < 0.3) return null
  return { collectionId: top.id, title: top.title, score: Number(top.score) }
}

async function findOrCreateSection(collectionId, sectionName) {
  if (!sectionName) return null
  const existing = await query(
    `SELECT id FROM resource_collection_sections WHERE collection_id = $1 AND name ILIKE $2`,
    [collectionId, sectionName]
  )
  if (existing.rows.length > 0) return existing.rows[0].id

  const countResult = await query(
    `SELECT COUNT(*) FROM resource_collection_sections WHERE collection_id = $1`,
    [collectionId]
  )
  const inserted = await query(
    `INSERT INTO resource_collection_sections (collection_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id`,
    [collectionId, sectionName, Number(countResult.rows[0].count)]
  )
  return inserted.rows[0].id
}

function guessSectionName(resourceTypeSlug, edition) {
  if (edition) return 'Other Editions'
  if (resourceTypeSlug === 'audio') return 'Audio'
  if (resourceTypeSlug === 'video') return 'Video'
  if (resourceTypeSlug === 'book') return 'Book'
  return null
}

async function main() {
  const result = await query(
    `SELECT r.id, r.file_name, rt.slug AS resource_type_slug
     FROM resources r
     JOIN resource_types rt ON rt.id = r.resource_type_id
     WHERE r.status = 'approved' AND r.collection_id IS NULL`
  )

  console.log(`Scanning ${result.rows.length} existing resources with no collection...\n`)

  let assigned = 0
  let needsReview = 0

  for (const row of result.rows) {
    const signals = parseFilenameSignals(row.file_name)
    const match = await matchCollection(signals.titleGuess)

    if (match && match.score >= HIGH_CONFIDENCE_THRESHOLD) {
      const sectionName = guessSectionName(row.resource_type_slug, signals.edition)
      const sectionId = await findOrCreateSection(match.collectionId, sectionName)

      await query(
        `UPDATE resources
         SET collection_id = $1, collection_section_id = $2, chapter = $3, part = $4, volume = $5, edition = $6
         WHERE id = $7`,
        [match.collectionId, sectionId, signals.chapter, signals.part, signals.volume, signals.edition, row.id]
      )

      console.log(`✅ ASSIGNED  [${row.id}] "${row.file_name}" → "${match.title}" (score ${match.score.toFixed(2)})`)
      assigned++
    } else if (match) {
      console.log(`❓ REVIEW    [${row.id}] "${row.file_name}" → possible: "${match.title}" (score ${match.score.toFixed(2)}, too low to auto-apply)`)
      needsReview++
    } else {
      console.log(`⬜ NO MATCH  [${row.id}] "${row.file_name}" — nothing detected`)
      needsReview++
    }
  }

  console.log(`\nDone. ${assigned} auto-assigned, ${needsReview} left for manual review in the admin screen.`)
  process.exit(0)
}

main().catch((err) => {
  console.error('Backfill failed:', err)
  process.exit(1)
})