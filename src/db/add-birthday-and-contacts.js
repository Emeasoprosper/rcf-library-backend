import { pool } from './pool.js'
try {
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_month SMALLINT CHECK (birth_month BETWEEN 1 AND 12)')
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_day SMALLINT CHECK (birth_day BETWEEN 1 AND 31)')
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT')
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_number TEXT')
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS birthday_public BOOLEAN NOT NULL DEFAULT TRUE')
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_public BOOLEAN NOT NULL DEFAULT FALSE')
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS birthday_emailed_year SMALLINT')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_users_birthday ON users (birth_month, birth_day)')
  console.log('✅ birthday and contact columns ready.')
} catch (err) {
  console.error('❌ Failed:', err.message)
} finally {
  await pool.end()
}