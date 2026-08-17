// Run with: npm run migrate
// Applies schema.sql in full. Safe to re-run only on a fresh database —
// this is a bootstrap script, not a versioned migration tool. Once the
// schema stabilizes, switch to node-pg-migrate or a similar tool for
// incremental changes instead of editing schema.sql directly.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pool } from './pool.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function migrate() {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf-8')
  console.log('Applying schema.sql...')
  try {
    await pool.query(sql)
    console.log('✅ Schema applied successfully.')
  } catch (err) {
    console.error('❌ Migration failed:', err.message)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

migrate()
