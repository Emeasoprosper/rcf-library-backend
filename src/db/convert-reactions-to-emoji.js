// src/db/convert-reactions-to-emoji.js
//
// The reactions table (from add-community-features.js) used a fixed
// Postgres ENUM: 'like' | 'helpful' | 'useful'. Real emoji reactions
// (👍 ❤️ 😂 😍 🔥 👏 😢 🙏 — matching the mockup) need `kind` to store
// arbitrary emoji text instead, with an application-level allowlist
// (see ALLOWED_REACTIONS in community.js) rather than a rigid DB enum,
// since the allowed set may grow later without another migration.
//
// Run: node src/db/convert-reactions-to-emoji.js

import { query, pool } from './pool.js'

async function run() {
  console.log('Converting reactions.kind to text...')

  // Map old enum values to their emoji equivalents before changing the
  // column type, so existing votes aren't lost.
  await query(`ALTER TABLE reactions ALTER COLUMN kind TYPE TEXT USING kind::text`)

  await query(`
    UPDATE reactions SET kind = CASE kind
      WHEN 'like' THEN '👍'
      WHEN 'helpful' THEN '🙏'
      WHEN 'useful' THEN '🔥'
      ELSE kind
    END
  `)

  // Drop the now-unused enum type (only if nothing else references it).
  await query(`DROP TYPE IF EXISTS reaction_kind`)

  console.log('Done. Existing reactions remapped: like->👍, helpful->🙏, useful->🔥')
  await pool.end()
}

run().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})