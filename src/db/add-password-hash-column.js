// RCFMOUAULIBRARYreact/rcf-library-backend/src/db/add-password-hash-column.js
import { query } from './pool.js'

async function run() {
  await query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_hash TEXT
  `)

  // google_id must become optional since email/password users won't have one
  await query(`
    ALTER TABLE users
    ALTER COLUMN google_id DROP NOT NULL
  `)

  console.log('Migration complete: password_hash column added, google_id made optional.')
  process.exit(0)
}

run().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})