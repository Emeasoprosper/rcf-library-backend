// rcf-library-backend/src/db/add-study-tools.js
import { query } from './pool.js'

// Safe to run more than once: every statement is IF NOT EXISTS.
const SQL = `
CREATE TABLE IF NOT EXISTS study_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id UUID REFERENCES resources(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_study_notes_user ON study_notes(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS question_sets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id    UUID REFERENCES resources(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  mode           TEXT NOT NULL DEFAULT 'practice',
  difficulty     TEXT NOT NULL DEFAULT 'medium',
  page_from      INTEGER,
  page_to        INTEGER,
  time_limit_min INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_question_sets_user ON question_sets(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS questions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id      UUID NOT NULL REFERENCES question_sets(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  options     JSONB,
  answer      TEXT NOT NULL,
  explanation TEXT
);
CREATE INDEX IF NOT EXISTS idx_questions_set ON questions(set_id, position);

CREATE TABLE IF NOT EXISTS question_attempts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id           UUID NOT NULL REFERENCES question_sets(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  submitted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  score            INTEGER NOT NULL DEFAULT 0,
  total            INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER,
  answers          JSONB
);
CREATE INDEX IF NOT EXISTS idx_question_attempts_user ON question_attempts(user_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_question_attempts_set ON question_attempts(set_id, submitted_at DESC);
`

async function migrate() {
  await query(SQL)
  console.log('✅ Study tools tables ready.')
  process.exit(0)
}

migrate().catch((err) => {
  console.error('❌ Migration failed:', err.message)
  process.exit(1)
})