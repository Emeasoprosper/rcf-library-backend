// RCFMOUAULIBRARYreact/rcf-library-backend/src/db/add-resource-categories-table.js
// Run once: node src/db/add-resource-categories-table.js
import { pool } from './pool.js'

const sql = `
CREATE TABLE IF NOT EXISTS resource_categories (
  resource_id  UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (resource_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_categories_category_id ON resource_categories(category_id);

-- Backfill: every resource that already had a single category_id keeps
-- that category in the new multi-category table too, so nothing already
-- categorized loses its category once this table becomes the real source
-- of truth.
INSERT INTO resource_categories (resource_id, category_id)
SELECT id, category_id FROM resources WHERE category_id IS NOT NULL
ON CONFLICT DO NOTHING;
`

try {
  await pool.query(sql)
  console.log('✅ resource_categories table created and backfilled.')
} catch (err) {
  console.error('❌ Failed:', err.message)
} finally {
  await pool.end()
}