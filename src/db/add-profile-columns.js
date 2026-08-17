// RCFMOUAULIBRARYreact/rcf-library-backend/src/db/add-profile-columns.js
// Run once: node src/db/add-profile-columns.js
import { query } from './pool.js'

async function run() {
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS affiliation TEXT`)
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS category TEXT`)
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS institution_name TEXT`)
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT`)
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS level TEXT`)
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS student_id TEXT`)
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT`)
  console.log('✅ Profile columns added to users (affiliation, category, institution_name, department, level, student_id, bio)')
  process.exit(0)
}

run().catch((err) => {
  console.error('❌ Migration failed:', err)
  process.exit(1)
})