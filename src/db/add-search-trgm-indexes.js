// Adds trigram indexes on resources.title and resources.author so
// ILIKE '%term%' and pg_trgm's similarity()/% fuzzy matching (used by
// the smart search in routes/resources.js) stay fast as the library
// grows. pg_trgm itself is already enabled in schema.sql — this just
// adds the indexes that were missing.
//
// Run once: node src/db/add-search-trgm-indexes.js
import { query } from './pool.js'

async function run() {
  console.log('Adding trigram indexes for smart search...')

  await query(`
    CREATE INDEX IF NOT EXISTS idx_resources_title_trgm
    ON resources USING GIN (title gin_trgm_ops)
  `)
  console.log('✓ idx_resources_title_trgm')

  await query(`
    CREATE INDEX IF NOT EXISTS idx_resources_author_trgm
    ON resources USING GIN (author gin_trgm_ops)
  `)
  console.log('✓ idx_resources_author_trgm')

  console.log('Done.')
  process.exit(0)
}

run().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})