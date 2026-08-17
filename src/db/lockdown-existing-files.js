// db/lockdown-existing-files.js
//
// One-time cleanup: revokes the public "anyone can read" permission on
// every already-uploaded resource file, so old Drive links stop working
// as a bypass around the app. Thumbnails are left alone — those are
// meant to stay public. Safe to re-run; already-private files are
// skipped silently.
import { query } from './pool.js'
import { revokePublicAccess } from '../services/storage.js'

async function lockdown() {
  const result = await query(`SELECT id, title, file_id FROM resources WHERE file_id IS NOT NULL`)
  console.log(`Found ${result.rows.length} resources to check.`)

  let revoked = 0
  let alreadyPrivate = 0
  let failed = 0

  for (const row of result.rows) {
    try {
      const wasPublic = await revokePublicAccess(row.file_id)
      if (wasPublic) {
        revoked++
        console.log(`Locked down: "${row.title}" (${row.file_id})`)
      } else {
        alreadyPrivate++
      }
    } catch (err) {
      failed++
      console.error(`Failed to lock down "${row.title}" (${row.file_id}):`, err.message)
    }
  }

  console.log(`\nDone. Revoked: ${revoked}, already private: ${alreadyPrivate}, failed: ${failed}`)
  process.exit(0)
}

lockdown().catch((err) => {
  console.error('Lockdown script failed:', err)
  process.exit(1)
})