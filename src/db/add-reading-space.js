// rcf-library-backend/src/db/add-reading-space.js
import { query } from './pool.js'

// Safe to run more than once: every statement is IF NOT EXISTS.
const SQL = `
CREATE TABLE IF NOT EXISTS resource_text (
  resource_id     UUID PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
  content         TEXT NOT NULL DEFAULT '',
  char_count      INTEGER NOT NULL DEFAULT 0,
  page_count      INTEGER,
  pages_extracted INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  error           TEXT,
  extracted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_resource_text_status ON resource_text(status);

CREATE TABLE IF NOT EXISTS study_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id       UUID REFERENCES resources(id) ON DELETE SET NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  active_seconds    INTEGER NOT NULL DEFAULT 0,
  start_page        INTEGER,
  furthest_page     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_study_sessions_user ON study_sessions(user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS study_plans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  resource_id   UUID REFERENCES resources(id) ON DELETE SET NULL,
  planned_start TIMESTAMPTZ NOT NULL,
  duration_min  INTEGER NOT NULL DEFAULT 30 CHECK (duration_min BETWEEN 5 AND 600),
  notes         TEXT,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_study_plans_user ON study_plans(user_id, planned_start);
`

async function migrate() {
  await query(SQL)
  console.log('✅ Reading Space tables ready.')
  process.exit(0)
}

migrate().catch((err) => {
  console.error('❌ Migration failed:', err.message)
  process.exit(1)
})