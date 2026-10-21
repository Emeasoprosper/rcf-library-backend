import { pool } from './pool.js'
try {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS push_prefs JSONB NOT NULL DEFAULT '{}'::jsonb`)
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS birthday_pushed_year SMALLINT')

  const col = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'resources' AND column_name = 'push_announced'`
  )
  const firstRun = col.rows.length === 0
  await pool.query('ALTER TABLE resources ADD COLUMN IF NOT EXISTS push_announced BOOLEAN NOT NULL DEFAULT false')
  // Everything already in the library must NOT trigger a "new resources" push.
  if (firstRun) await pool.query('UPDATE resources SET push_announced = true')
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_resources_push_pending ON resources (status) WHERE push_announced = false'
  )
  console.log('✅ push_prefs, birthday_pushed_year and push_announced ready.')
} catch (err) {
  console.error('❌ Failed:', err.message)
} finally {
  await pool.end()
}