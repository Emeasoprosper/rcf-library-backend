// rcf-library-backend/src/db/add-resource-collections.js
import { query } from './pool.js'

async function main() {
  await query(`
    CREATE TABLE IF NOT EXISTS resource_collections (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title        TEXT NOT NULL,
      author       TEXT,
      description  TEXT,
      cover_file_id TEXT,
      cover_url    TEXT,
      created_by   UUID REFERENCES users(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS resource_collection_sections (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      collection_id UUID NOT NULL REFERENCES resource_collections(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      sort_order    SMALLINT NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (collection_id, name)
    );
  `)

  // Nullable — every existing resource keeps working untouched.
  // sort_order lets a section render "Chapter 1, 2, 3..." in order
  // even if uploaded out of sequence.
  await query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS collection_id UUID REFERENCES resource_collections(id) ON DELETE SET NULL;`)
  await query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS collection_section_id UUID REFERENCES resource_collection_sections(id) ON DELETE SET NULL;`)
  await query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS chapter TEXT;`)
  await query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS part TEXT;`)
  await query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS volume TEXT;`)
  await query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS edition TEXT;`)
  await query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS collection_sort_order SMALLINT NOT NULL DEFAULT 0;`)

  await query(`CREATE INDEX IF NOT EXISTS idx_resources_collection ON resources(collection_id);`)
  await query(`CREATE INDEX IF NOT EXISTS idx_resources_collection_section ON resources(collection_section_id);`)

  // Semantic/related-resource links — many-to-many, no file duplication.
  // relation_source records WHY they're linked (category/tag/author/
  // course/ai_semantic) so recommendations can be explained/audited later.
  await query(`
    CREATE TABLE IF NOT EXISTS resource_relations (
      resource_id         UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      related_resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      relation_score       REAL NOT NULL DEFAULT 1.0,
      relation_source      TEXT NOT NULL,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (resource_id, related_resource_id),
      CHECK (resource_id <> related_resource_id)
    );
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_resource_relations_related ON resource_relations(related_resource_id);`)

  console.log('resource_collections schema added successfully.')
  process.exit(0)
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})