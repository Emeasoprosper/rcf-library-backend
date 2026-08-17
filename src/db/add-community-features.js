// src/db/add-community-features.js
//
// Adds everything needed for the reworked Contribute area:
//   - resource_reports          (user reports a resource; admin resolves)
//   - discussion_threads        (top-level posts in Suggest Material —
//                                supersedes material_suggestions as the
//                                display layer while keeping votes intact)
//   - discussion_replies        (threaded replies to a suggestion/report/thread)
//   - reactions                 (Like / Helpful / Useful — polymorphic,
//                                works on suggestions, replies, or reports)
//   - attachments               (files or resource-links dropped into a
//                                thread/reply/message — polymorphic)
//   - conversations             (one admin<->user DM thread)
//   - conversation_messages     (messages inside a conversation)
//   - material_requests gets a category_id + a JSONB `details` column so
//     the "What are you looking for" form can carry category-specific
//     fields (e.g. edition/ISBN for a book, exam year/semester for a
//     past question) without a rigid fixed-column schema per category.
//
// Run with: node src/db/add-community-features.js
// (same convention as the other one-off scripts in this folder — uses
// the shared `query` helper from pool.js, not a migration framework.)

import { query, pool } from './pool.js'

async function run() {
  console.log('Adding community feature tables...')

  // ---------------------------------------------------------
  // material_requests: category + dynamic per-category fields
  // ---------------------------------------------------------
  await query(`
    ALTER TABLE material_requests
      ADD COLUMN IF NOT EXISTS category_id SMALLINT REFERENCES categories(id),
      ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}'::jsonb
  `)

  // ---------------------------------------------------------
  // RESOURCE REPORTS
  // ---------------------------------------------------------
  await query(`
    DO $$ BEGIN
      CREATE TYPE report_reason AS ENUM (
        'wrong_file', 'broken_link', 'poor_quality', 'copyright',
        'duplicate', 'inappropriate', 'wrong_metadata', 'other'
      );
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `)

  await query(`
    DO $$ BEGIN
      CREATE TYPE report_status AS ENUM ('open', 'resolved', 'dismissed');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS resource_reports (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      resource_id   UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      reported_by   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason        report_reason NOT NULL,
      details       TEXT,
      status        report_status NOT NULL DEFAULT 'open',
      resolved_by   UUID REFERENCES users(id),
      resolved_at   TIMESTAMPTZ,
      resolution_note TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_resource_reports_status ON resource_reports(status)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_resource_reports_resource ON resource_reports(resource_id)`)

  // ---------------------------------------------------------
  // DISCUSSION THREADS (the community feed under "Suggest Material")
  // One thread per material_suggestion, 1:1 — keeps material_suggestions
  // as the source of truth for votes/status, adds the social layer here
  // instead of overloading that table.
  // ---------------------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS discussion_threads (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      suggestion_id  UUID NOT NULL UNIQUE REFERENCES material_suggestions(id) ON DELETE CASCADE,
      is_locked      BOOLEAN NOT NULL DEFAULT FALSE,
      reply_count    INTEGER NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  // ---------------------------------------------------------
  // DISCUSSION REPLIES — polymorphic parent: a reply belongs to a
  // discussion_thread OR is a reply-to-a-reply (self-referencing).
  // ---------------------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS discussion_replies (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id     UUID NOT NULL REFERENCES discussion_threads(id) ON DELETE CASCADE,
      parent_reply_id UUID REFERENCES discussion_replies(id) ON DELETE CASCADE,
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body          TEXT NOT NULL,
      is_deleted    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_discussion_replies_thread ON discussion_replies(thread_id, created_at)`)
  await query(`CREATE INDEX IF NOT EXISTS idx_discussion_replies_parent ON discussion_replies(parent_reply_id)`)

  // ---------------------------------------------------------
  // REACTIONS — polymorphic (target_type + target_id), one reaction
  // per user per target (changing your reaction replaces it, doesn't
  // stack). target_type is an app-level string ('suggestion' | 'reply'),
  // not a DB FK, since it points at two different tables.
  // ---------------------------------------------------------
  await query(`
    DO $$ BEGIN
      CREATE TYPE reaction_kind AS ENUM ('like', 'helpful', 'useful');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS reactions (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      target_type  TEXT NOT NULL CHECK (target_type IN ('suggestion', 'reply')),
      target_id    UUID NOT NULL,
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind         reaction_kind NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (target_type, target_id, user_id)
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_reactions_target ON reactions(target_type, target_id)`)

  // ---------------------------------------------------------
  // ATTACHMENTS — a file OR a resource-link dropped into a reply or a
  // conversation message. Exactly one of file_url / resource_id is set,
  // enforced by the CHECK constraint below.
  // ---------------------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS attachments (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      target_type   TEXT NOT NULL CHECK (target_type IN ('reply', 'message')),
      target_id     UUID NOT NULL,
      resource_id   UUID REFERENCES resources(id) ON DELETE SET NULL,
      file_url      TEXT,
      file_name     TEXT,
      file_type     TEXT,
      file_size_bytes BIGINT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT attachment_is_file_or_resource CHECK (
        (resource_id IS NOT NULL AND file_url IS NULL) OR
        (resource_id IS NULL AND file_url IS NOT NULL)
      )
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_attachments_target ON attachments(target_type, target_id)`)

  // ---------------------------------------------------------
  // CONVERSATIONS — one DM thread between a user and "the admin team".
  // Optionally anchored to a report or a request, so opening "Message
  // admin" from a specific report pre-links the context.
  // ---------------------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      report_id     UUID REFERENCES resource_reports(id) ON DELETE SET NULL,
      request_id    UUID REFERENCES material_requests(id) ON DELETE SET NULL,
      last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, last_message_at DESC)`)

  await query(`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body            TEXT,
      is_read         BOOLEAN NOT NULL DEFAULT FALSE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS idx_conversation_messages_conv ON conversation_messages(conversation_id, created_at)`)

  console.log('Done.')
  await pool.end()
}

run().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})