// Run once: node src/db/add-resource-collections-many-to-many.js
import { pool } from './pool.js'

const sql = `
CREATE TABLE IF NOT EXISTS resource_collection_links (
  resource_id    UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  collection_id  UUID NOT NULL REFERENCES resource_collections(id) ON DELETE CASCADE,
  PRIMARY KEY (resource_id, collection_id)
);

INSERT INTO resource_collection_links (resource_id, collection_id)
SELECT id, collection_id FROM resources WHERE collection_id IS NOT NULL
ON CONFLICT DO NOTHING;
`
try {
  await pool.query(sql)
  console.log('✅ resource_collection_links table created and backfilled.')
} catch (err) {
  console.error('❌ Failed:', err.message)
} finally {
  await pool.end()
}