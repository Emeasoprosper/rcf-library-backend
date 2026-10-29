// RCFMOUAULIBRARYreact/rcf-library-backend/src/db/add-whatsapp-control-center.js
// Run once: node src/db/add-whatsapp-control-center.js
// Tables for the superadmin "Bro Paul Control Center":
//   whatsapp_bot_settings - one row of feature switches the bot reloads every minute
//   whatsapp_bot_facts    - verified RCF facts the AI is allowed to share
//   whatsapp_bot_outbox   - messages a superadmin asked the bot to send
//   whatsapp_bot_activity - recent things the bot did (kept trimmed)
import { query } from './pool.js'

async function run() {
  await query(`
    CREATE TABLE IF NOT EXISTS whatsapp_bot_settings (
      id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_by  UUID REFERENCES users(id),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
  await query(`INSERT INTO whatsapp_bot_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`)

  await query(`
    CREATE TABLE IF NOT EXISTS whatsapp_bot_facts (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title       TEXT NOT NULL,
      text        TEXT NOT NULL,
      created_by  UUID REFERENCES users(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)

  await query(`
    CREATE TABLE IF NOT EXISTS whatsapp_bot_outbox (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_jid   TEXT NOT NULL,
      text        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      error       TEXT,
      created_by  UUID REFERENCES users(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at     TIMESTAMPTZ
    )`)
  await query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_outbox_pending ON whatsapp_bot_outbox (created_at) WHERE status = 'pending'`)

  await query(`
    CREATE TABLE IF NOT EXISTS whatsapp_bot_activity (
      id          BIGSERIAL PRIMARY KEY,
      kind        TEXT NOT NULL,
      group_jid   TEXT,
      summary     TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
  await query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_activity_created ON whatsapp_bot_activity (created_at DESC)`)

  console.log('✅ control center tables ready (whatsapp_bot_settings, whatsapp_bot_facts, whatsapp_bot_outbox, whatsapp_bot_activity)')
  process.exit(0)
}

run().catch((err) => {
  console.error('❌ Migration failed:', err)
  process.exit(1)
})
