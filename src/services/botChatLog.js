// RCFMOUAULIBRARYreact/rcf-library-backend/src/services/botChatLog.js
// Saved WhatsApp conversations with Bro Paul, for the admin app's Chats tab:
// every private chat, and in groups the messages addressed to him plus
// everything he posts. The log has its own storage limit (Control Center
// settings): superadmins get a push at 80%, and when it is full the oldest
// messages are deleted automatically (if allowed) so it never grows forever.
import { query } from '../db/pool.js'
import { sendPush } from './pushService.js'
import { getBotSettings } from './botSettings.js'

// Tables/columns are created on first use, so no separate migration is needed.
let ensured = null
export function ensureChatLogTables() {
  ensured ||= (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS whatsapp_messages (
        id          BIGSERIAL PRIMARY KEY,
        chat_jid    TEXT NOT NULL,
        chat_type   TEXT NOT NULL,
        chat_name   TEXT,
        sender_name TEXT,
        from_bot    BOOLEAN NOT NULL DEFAULT FALSE,
        kind        TEXT NOT NULL DEFAULT 'text',
        text        TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
    await query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_chat ON whatsapp_messages (chat_jid, id DESC)`)
    // Outbox rows can be a typed message or an "introduce yourself" request.
    await query(`ALTER TABLE whatsapp_bot_outbox ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text'`)
  })().catch((err) => {
    ensured = null
    throw err
  })
  return ensured
}

// Roughly how much the saved messages take, in bytes (text plus a fixed
// per-row overhead). Measured from the rows themselves, so deleting old
// messages brings it down straight away.
const ROW_OVERHEAD = 80
export async function chatLogUsage() {
  await ensureChatLogTables()
  const [size, settings] = await Promise.all([
    query(
      `SELECT COUNT(*)::bigint AS rows,
              COALESCE(SUM(octet_length(text) + COALESCE(octet_length(sender_name), 0) + COALESCE(octet_length(chat_name), 0)), 0)::bigint AS bytes
       FROM whatsapp_messages`
    ),
    getBotSettings(),
  ])
  const rows = Number(size.rows[0].rows)
  const usedBytes = Number(size.rows[0].bytes) + rows * ROW_OVERHEAD
  const limitBytes = settings.chatLogLimitMb * 1024 * 1024
  return { rows, usedBytes, limitBytes, percent: limitBytes ? Math.round((usedBytes / limitBytes) * 100) : 0, autoDelete: settings.chatLogAutoDelete, saveChats: settings.saveChats }
}

async function superadminIds() {
  const admins = await query(`SELECT id FROM users WHERE role = 'superadmin' AND is_suspended = false`)
  return admins.rows.map((r) => r.id)
}

// Checked after new messages arrive, at most every few minutes.
const CHECK_EVERY_MS = 5 * 60 * 1000
let lastCheck = 0
let alertedDay = ''
let fullAlertedDay = ''

export async function enforceChatLogLimit() {
  if (Date.now() - lastCheck < CHECK_EVERY_MS) return
  lastCheck = Date.now()
  const usage = await chatLogUsage()
  const today = new Date().toISOString().slice(0, 10)

  if (usage.percent >= 80 && usage.percent < 100 && alertedDay !== today) {
    alertedDay = today
    sendPush({
      category: 'updates',
      userIds: await superadminIds(),
      title: `Bro Paul's chat storage is ${usage.percent}% full`,
      body: usage.autoDelete
        ? 'When it is full the oldest messages are deleted automatically. Download them first if you want to keep them.'
        : 'When it is full new messages stop being saved. Download and clear old chats in the admin app.',
      url: '/admin/whatsapp',
      tag: 'wa-chat-storage',
    }).catch((err) => console.error('Chat storage push failed:', err.message))
  }

  if (usage.percent < 100) return
  if (usage.autoDelete) {
    // Delete the oldest messages until it is back to 90%.
    const toFree = usage.usedBytes - usage.limitBytes * 0.9
    const avgRow = usage.rows ? usage.usedBytes / usage.rows : 1
    const count = Math.max(1, Math.ceil(toFree / avgRow))
    await query(`DELETE FROM whatsapp_messages WHERE id IN (SELECT id FROM whatsapp_messages ORDER BY id ASC LIMIT $1)`, [count])
    console.log(`Chat log full: deleted the ${count} oldest messages.`)
    lastCheck = 0
  } else if (fullAlertedDay !== today) {
    fullAlertedDay = today
    sendPush({
      category: 'updates',
      userIds: await superadminIds(),
      title: "Bro Paul's chat storage is full",
      body: 'New messages are no longer being saved. Download and clear old chats in the admin app.',
      url: '/admin/whatsapp',
      tag: 'wa-chat-storage',
    }).catch((err) => console.error('Chat storage push failed:', err.message))
  }
}

const KINDS = ['text', 'voice', 'image', 'sticker', 'post']

// Saves a batch from the bot. Skipped when saving is switched off, or when
// the log is full and old messages may not be deleted.
export async function saveChatMessages(messages) {
  await ensureChatLogTables()
  const usage = await chatLogUsage()
  if (!usage.saveChats || (usage.percent >= 100 && !usage.autoDelete)) return 0
  let saved = 0
  for (const m of messages) {
    if (!m?.chatJid || !m?.text) continue
    await query(
      `INSERT INTO whatsapp_messages (chat_jid, chat_type, chat_name, sender_name, from_bot, kind, text, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE(to_timestamp($8::double precision / 1000), now()))`,
      [
        String(m.chatJid).slice(0, 80),
        m.chatType === 'private' ? 'private' : 'group',
        m.chatName ? String(m.chatName).slice(0, 120) : null,
        m.senderName ? String(m.senderName).slice(0, 80) : null,
        !!m.fromBot,
        KINDS.includes(m.kind) ? m.kind : 'text',
        String(m.text).slice(0, 4000),
        Number.isFinite(m.at) ? m.at : null,
      ]
    )
    saved += 1
  }
  enforceChatLogLimit().catch((err) => console.error('Chat log limit check failed:', err.message))
  return saved
}
