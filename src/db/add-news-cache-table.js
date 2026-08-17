// db/add-news-cache-table.js
// Run once: node src/db/add-news-cache-table.js
import { query } from './pool.js'

async function run() {
  await query(`
    CREATE TABLE IF NOT EXISTS news_cache (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      payload JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  console.log('news_cache table ready.')
  process.exit(0)
}

run().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})