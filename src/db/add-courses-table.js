import { query } from './pool.js'

// Adds the real MOUAU course database that feature 5 requires: a course
// code (e.g. "CSC 415") resolves to an official title/department/level,
// so AI-detected course codes get checked against ground truth instead of
// ever being trusted directly. Also adds `colleges` (a college groups
// several departments — e.g. College of Education) and links departments
// to their college, since a course's "college" is derived through its
// department, not stored redundantly on every course row.

async function run() {
  await query(`
    CREATE TABLE IF NOT EXISTS colleges (
      id   SMALLSERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    )
  `)
  console.log('✅ colleges table created (or already existed)')

  await query(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS college_id SMALLINT REFERENCES colleges(id)`)
  console.log('✅ college_id column added to departments')

  await query(`
    CREATE TABLE IF NOT EXISTS courses (
      id            SERIAL PRIMARY KEY,
      code          TEXT UNIQUE NOT NULL,
      title         TEXT NOT NULL,
      department_id SMALLINT REFERENCES departments(id),
      level         TEXT
    )
  `)
  console.log('✅ courses table created (or already existed)')

  await query(`CREATE INDEX IF NOT EXISTS idx_courses_code_trgm ON courses USING GIN (code gin_trgm_ops)`)
  console.log('✅ courses trigram index ready')

  process.exit(0)
}

run().catch((err) => {
  console.error('❌ Migration failed:', err)
  process.exit(1)
})