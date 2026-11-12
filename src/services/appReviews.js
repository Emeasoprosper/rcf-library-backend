import { query } from '../db/pool.js'

// App ratings grew from "stars only" into reviews: a written review, a
// review/complaint flag, quick tags, and what prompted it. The columns are
// added on first use so no separate migration step is needed.
let ready = null

export function ensureReviewColumns() {
  ready ||= query(`
    CREATE TABLE IF NOT EXISTS app_ratings (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stars       SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE app_ratings ADD COLUMN IF NOT EXISTS review TEXT;
    ALTER TABLE app_ratings ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'review';
    ALTER TABLE app_ratings ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
    ALTER TABLE app_ratings ADD COLUMN IF NOT EXISTS trigger TEXT;
    ALTER TABLE app_ratings ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_app_ratings_created ON app_ratings (created_at DESC);
  `).catch((err) => {
    ready = null
    throw err
  })
  return ready
}
