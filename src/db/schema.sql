-- =========================================================
-- RCF MOUAU Digital Library — Core Schema (PostgreSQL)
-- =========================================================
-- Design notes:
--  - UUID primary keys (portable, no ID-guessing, safe for
--    public URLs like /resources/:id).
--  - Lookup tables (resource_types, categories, departments)
--    kept separate rather than free-text columns, so the UI's
--    filter dropdowns and search facets stay consistent.
--  - Soft "status" fields instead of deletes, so admin actions
--    are auditable and reversible.
--  - Full text search via a generated tsvector column + GIN
--    index, so title/author/course/tag search stays fast as
--    the library grows without bolting on Elasticsearch.
-- =========================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- fuzzy/partial text search

-- ---------------------------------------------------------
-- USERS & ROLES
-- ---------------------------------------------------------

CREATE TYPE user_role AS ENUM ('student', 'admin', 'superadmin');

-- Whether the account belongs to a MOUAU-affiliated person or an outsider.
-- Null until they complete their profile.
CREATE TYPE affiliation_type AS ENUM ('mouau', 'other');

-- What kind of MOUAU/outside person they are. Null until profile completed.
CREATE TYPE member_category AS ENUM ('student', 'staff', 'alumnus', 'other');

CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_id         TEXT UNIQUE NOT NULL,
  email             TEXT UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  avatar_url        TEXT,

  -- Identity/enrollment verification — set only via Complete Profile,
  -- never inferred from the sign-in email.
  affiliation       affiliation_type,        -- 'mouau' | 'other', null = not completed
  category          member_category,         -- 'student' | 'staff' | 'alumnus' | 'other'
  institution_name  TEXT,                    -- filled only when affiliation = 'other'
  student_id        TEXT,                    -- e.g. MOUAU/2023/1045 — mouau students only
  department        TEXT,                    -- mouau students/staff
  level             TEXT,                    -- e.g. '400' — mouau students only

  role              user_role NOT NULL DEFAULT 'student',
  bio               TEXT,
  show_profile       BOOLEAN NOT NULL DEFAULT TRUE,
  show_history       BOOLEAN NOT NULL DEFAULT FALSE,
  is_suspended       BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_affiliation ON users(affiliation, category);

-- Refresh-token sessions (rotate on use; supports "sign out everywhere")
CREATE TABLE sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL,
  user_agent        TEXT,
  ip_address        TEXT,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ---------------------------------------------------------
-- LOOKUP / TAXONOMY TABLES
-- ---------------------------------------------------------

CREATE TABLE resource_types (
  id        SMALLSERIAL PRIMARY KEY,
  slug      TEXT UNIQUE NOT NULL,   -- 'book' | 'past_question' | 'research_paper' | ...
  label     TEXT NOT NULL,
  icon      TEXT NOT NULL           -- material symbol name, matches frontend categoryIcons maps
);

CREATE TABLE categories (
  id        SMALLSERIAL PRIMARY KEY,
  name      TEXT UNIQUE NOT NULL    -- 'Theology', 'History', 'Leadership', ...
);

CREATE TABLE departments (
  id        SMALLSERIAL PRIMARY KEY,
  name      TEXT UNIQUE NOT NULL
);

CREATE TABLE tags (
  id        SERIAL PRIMARY KEY,
  name      TEXT UNIQUE NOT NULL
);

-- ---------------------------------------------------------
-- RESOURCES (the core entity: books, papers, audio, video, etc.)
-- ---------------------------------------------------------

CREATE TYPE resource_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE resources (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  title             TEXT NOT NULL,
  author            TEXT,
  description       TEXT,
  course_code       TEXT,
  department_id     SMALLINT REFERENCES departments(id),
  category_id       SMALLINT REFERENCES categories(id),
  resource_type_id  SMALLINT NOT NULL REFERENCES resource_types(id),
  level             TEXT,                 -- '100'..'500'
  semester          TEXT,                 -- 'First' | 'Second'

  -- File storage (Google Drive today; swappable to R2 later)
  storage_provider  TEXT NOT NULL DEFAULT 'google_drive',
  file_id           TEXT NOT NULL,        -- Drive file ID or R2 object key
  file_url          TEXT NOT NULL,        -- direct/streamable URL
  file_name         TEXT NOT NULL,
  file_type         TEXT NOT NULL,        -- mime type
  file_size_bytes   BIGINT NOT NULL,

  -- Generated preview (never a placeholder — see preview pipeline)
  thumbnail_url     TEXT,
  thumbnail_status  TEXT NOT NULL DEFAULT 'pending', -- pending | processing | ready | unavailable

  -- Extracted metadata (nullable — not every type has every field)
  page_count        INTEGER,
  duration_seconds  INTEGER,          -- audio/video
  width_px          INTEGER,
  height_px         INTEGER,
  aspect_ratio      TEXT,             -- e.g. '16:9'
  est_reading_min   INTEGER,
  est_listening_min INTEGER,
  est_watching_min  INTEGER,

  status            resource_status NOT NULL DEFAULT 'pending',
  uploaded_by       UUID NOT NULL REFERENCES users(id),
  reviewed_by       UUID REFERENCES users(id),
  reviewed_at       TIMESTAMPTZ,
  rejection_reason  TEXT,

  download_count    INTEGER NOT NULL DEFAULT 0,
  view_count        INTEGER NOT NULL DEFAULT 0,

  search_vector     tsvector GENERATED ALWAYS AS (
                       setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                       setweight(to_tsvector('english', coalesce(author, '')), 'B') ||
                       setweight(to_tsvector('english', coalesce(course_code, '')), 'B') ||
                       setweight(to_tsvector('english', coalesce(description, '')), 'C')
                     ) STORED,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_resources_search ON resources USING GIN (search_vector);
CREATE INDEX idx_resources_status ON resources(status);
CREATE INDEX idx_resources_type ON resources(resource_type_id);
CREATE INDEX idx_resources_category ON resources(category_id);
CREATE INDEX idx_resources_department ON resources(department_id);
CREATE INDEX idx_resources_course_trgm ON resources USING GIN (course_code gin_trgm_ops);
CREATE INDEX idx_resources_uploaded_by ON resources(uploaded_by);

CREATE TABLE resource_tags (
  resource_id  UUID REFERENCES resources(id) ON DELETE CASCADE,
  tag_id       INTEGER REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (resource_id, tag_id)
);

-- ---------------------------------------------------------
-- ENGAGEMENT: downloads, bookmarks/collections, reading history
-- ---------------------------------------------------------

CREATE TABLE downloads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id   UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  downloaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_downloads_user ON downloads(user_id);
CREATE INDEX idx_downloads_resource ON downloads(resource_id);

CREATE TABLE collections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE bookmarks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id   UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  collection_id UUID REFERENCES collections(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, resource_id)
);

CREATE INDEX idx_bookmarks_user ON bookmarks(user_id);

CREATE TABLE reading_history (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id       UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  progress_percent  SMALLINT NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  completed_at      TIMESTAMPTZ,
  last_accessed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, resource_id)
);

CREATE INDEX idx_reading_history_user ON reading_history(user_id, last_accessed_at DESC);

-- ---------------------------------------------------------
-- CONTRIBUTIONS: material requests & suggestions
-- ---------------------------------------------------------

CREATE TYPE request_status AS ENUM ('open', 'fulfilled', 'declined');

CREATE TABLE material_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  course_code TEXT,
  notes       TEXT,
  status      request_status NOT NULL DEFAULT 'open',
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  fulfilled_resource_id UUID REFERENCES resources(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_material_requests_status ON material_requests(status);

CREATE TYPE suggestion_status AS ENUM ('pending', 'accepted', 'declined');

CREATE TABLE material_suggestions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  author        TEXT,
  publisher     TEXT,
  category_id   SMALLINT REFERENCES categories(id),
  department_id SMALLINT REFERENCES departments(id),
  course_code   TEXT,
  reason        TEXT,
  status        suggestion_status NOT NULL DEFAULT 'pending',
  votes_count   INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE suggestion_votes (
  suggestion_id UUID REFERENCES material_suggestions(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (suggestion_id, user_id)
);

-- ---------------------------------------------------------
-- NOTIFICATIONS & ANNOUNCEMENTS
-- ---------------------------------------------------------

CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,       -- 'resource_approved' | 'new_resources' | 'request_fulfilled' | ...
  title       TEXT NOT NULL,
  body        TEXT,
  link_to     TEXT,
  is_read     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user_unread ON notifications(user_id, is_read);

CREATE TYPE announcement_type AS ENUM ('announcement', 'news', 'advert');

CREATE TABLE announcements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            announcement_type NOT NULL,
  title           TEXT NOT NULL,
  message         TEXT NOT NULL,
  attachment_url  TEXT,
  send_email      BOOLEAN NOT NULL DEFAULT FALSE,
  created_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------
-- AUDIT LOG (admin actions — approvals, rejections, role changes)
-- ---------------------------------------------------------

CREATE TABLE audit_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id     UUID REFERENCES users(id),
  action       TEXT NOT NULL,       -- 'resource.approve' | 'user.role_change' | ...
  entity_type  TEXT NOT NULL,       -- 'resource' | 'user' | 'request' | ...
  entity_id    TEXT,
  metadata     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_id);

-- ---------------------------------------------------------
-- SEED DATA — lookup tables
-- ---------------------------------------------------------

INSERT INTO resource_types (slug, label, icon) VALUES
  ('book', 'Book', 'menu_book'),
  ('past_question', 'Past Question', 'quiz'),
  ('research_paper', 'Research Paper', 'article'),
  ('lecture_notes', 'Lecture Notes', 'description'),
  ('devotional', 'Devotional', 'auto_stories'),
  ('audio', 'Audio', 'graphic_eq'),
  ('video', 'Video Course', 'movie'),
  ('collection', 'Collection', 'library_books'),
  ('other', 'Other', 'more_horiz');

-- ---------------------------------------------------------
-- GOOGLE DRIVE DELEGATION (single-row: one Drive owner for the app)
-- ---------------------------------------------------------

CREATE TABLE google_drive_auth (
  id              SMALLINT PRIMARY KEY DEFAULT 1,
  refresh_token   TEXT NOT NULL,
  connected_email TEXT,
  connected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);