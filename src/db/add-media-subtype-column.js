import { query } from './pool.js'

// Adds media_subtype to resources: for audio 'single' | 'panel', for
// video 'sermon' | 'lecture' | 'interview' | 'recording' | 'testimony' |
// 'other'. Nullable, so nothing breaks for existing rows or non-audio/
// video resource types.

async function run() {
  await query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS media_subtype TEXT`)
  console.log('✅ media_subtype column added to resources')
  process.exit(0)
}

run().catch((err) => {
  console.error('❌ Migration failed:', err)
  process.exit(1)
})