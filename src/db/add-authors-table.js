// rcf-library-backend/src/db/add-authors-table.js
import { query } from './pool.js'

async function main() {
  await query(`
    CREATE TABLE IF NOT EXISTS authors (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name          TEXT NOT NULL,
      image_url     TEXT,
      image_source  TEXT,          -- 'wikipedia' | 'manual' | null (lookup found nothing)
      bio           TEXT,
      verified      BOOLEAN NOT NULL DEFAULT FALSE,  -- admin has manually confirmed this photo/bio is correct
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (name)
    );
  `)

  // Nullable, additive — every existing resource keeps working untouched.
  await query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS author_id UUID REFERENCES authors(id) ON DELETE SET NULL;`)
  await query(`CREATE INDEX IF NOT EXISTS idx_resources_author_id ON resources(author_id);`)

  console.log('authors table added successfully.')
  process.exit(0)
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})