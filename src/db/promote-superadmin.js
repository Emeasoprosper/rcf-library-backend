// RCFMOUAULIBRARYreact/rcf-library-backend/src/db/promote-superadmin.js
// Run once: node src/db/promote-superadmin.js
import { query } from './pool.js'

const EMAIL = 'emeasoprosper@gmail.com'

async function run() {
  const result = await query(
    `UPDATE users SET role = 'superadmin', updated_at = now() WHERE email = $1 RETURNING id, name, email, role`,
    [EMAIL]
  )
  if (result.rows.length === 0) {
    console.log(`❌ No user found with email ${EMAIL}`)
  } else {
    console.log('✅ Promoted:', result.rows[0])
  }
  process.exit(0)
}

run().catch((err) => {
  console.error('❌ Failed:', err)
  process.exit(1)
})