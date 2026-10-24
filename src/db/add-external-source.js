// Run once: node src/db/add-external-source.js
import { query } from './pool.js'

async function main() {
  await query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS external_source TEXT;`)
  await query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS external_id TEXT;`)
  await query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS external_url TEXT;`)
  await query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS external_licence TEXT;`)
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_external_unique
    ON resources (external_source, external_id) WHERE external_id IS NOT NULL;
  `)
  console.log('external source columns added successfully.')
  process.exit(0)
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})