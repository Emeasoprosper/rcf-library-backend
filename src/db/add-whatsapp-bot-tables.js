// RCFMOUAULIBRARYreact/rcf-library-backend/src/db/add-whatsapp-bot-tables.js
// Run once: node src/db/add-whatsapp-bot-tables.js
// Tables for the WhatsApp bot (Bro Paul):
//   whatsapp_bot_status - one row: online/QR state, shown on the superadmin page
//   whatsapp_groups     - every group the bot is in; superadmin can switch each off
//   whatsapp_auth       - the bot's WhatsApp login, so it survives restarts on a server
import { query } from './pool.js'

async function run() {
  await query(`
    CREATE TABLE IF NOT EXISTS whatsapp_bot_status (
      id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      state             TEXT NOT NULL DEFAULT 'offline',
      qr_data_url       TEXT,
      phone             TEXT,
      relink_requested  BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)
  await query(`INSERT INTO whatsapp_bot_status (id) VALUES (1) ON CONFLICT (id) DO NOTHING`)

  await query(`
    CREATE TABLE IF NOT EXISTS whatsapp_groups (
      jid           TEXT PRIMARY KEY,
      name          TEXT,
      enabled       BOOLEAN NOT NULL DEFAULT TRUE,
      member_count  INTEGER,
      added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)

  await query(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`)

  console.log('✅ whatsapp bot tables ready (whatsapp_bot_status, whatsapp_groups, whatsapp_auth)')
  process.exit(0)
}

run().catch((err) => {
  console.error('❌ Migration failed:', err)
  process.exit(1)
})
