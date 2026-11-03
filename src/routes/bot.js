// RCFMOUAULIBRARYreact/rcf-library-backend/src/routes/bot.js
// Private API for the WhatsApp bot (rcf-whatsapp-bot). Not for browsers.
// Auth is a shared secret: BOT_API_KEY here must match BOT_API_KEY in the
// bot's .env. If it isn't set, every route here is switched off.
import { Router } from 'express'
import crypto from 'node:crypto'
import { query } from '../db/pool.js'
import { sendPush } from '../services/pushService.js'
import { getBotSettings } from '../services/botSettings.js'
import { ensureGroupSettingsColumn, withGroupDefaults } from '../services/groupSettings.js'
import { ensureChatLogTables, saveChatMessages } from '../services/botChatLog.js'
import { verseOfTheDay, tipOfTheDay } from '../services/dailyInspiration.js'

const ACTIVITY_KEEP = 500

const router = Router()

function keyMatches(given, expected) {
  const a = Buffer.from(String(given || ''))
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

router.use((req, res, next) => {
  const expected = process.env.BOT_API_KEY
  if (!expected) return res.status(503).json({ error: 'Bot API is not configured' })
  if (!keyMatches(req.get('x-bot-key'), expected)) return res.status(401).json({ error: 'Unauthorized' })
  next()
})

// GET /bot/announcements/pending — live items the admin ticked "post to
// WhatsApp" for, that were never posted, or are due for their next repeat.
// Same schedule rules as /news so the group and the app agree.
router.get('/announcements/pending', async (req, res) => {
  const result = await query(
    `SELECT id, type, title, message, attachment_url, attachment_mime, link_url, whatsapp_repeat_hours
     FROM announcements
     WHERE post_to_whatsapp = TRUE
       AND (starts_at IS NULL OR starts_at <= now())
       AND (ends_at IS NULL OR ends_at >= now())
       AND (
         daily_start_time IS NULL OR daily_end_time IS NULL
         OR now()::time BETWEEN daily_start_time AND daily_end_time
       )
       AND (
         whatsapp_posted_at IS NULL
         OR (whatsapp_repeat_hours > 0 AND whatsapp_posted_at <= now() - make_interval(hours => whatsapp_repeat_hours))
       )
     ORDER BY created_at ASC
     LIMIT 5`
  )
  res.json({ items: result.rows })
})

// POST /bot/announcements/:id/posted — the bot calls this after posting.
router.post('/announcements/:id/posted', async (req, res) => {
  const result = await query(
    `UPDATE announcements SET whatsapp_posted_at = now() WHERE id = $1 RETURNING id`,
    [req.params.id]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Announcement not found' })
  res.json({ ok: true })
})

// POST /bot/status  { state, qrDataUrl?, phone? } — heartbeat + QR for the
// superadmin page. Replies with { relink } when a superadmin asked the bot
// to log out and show a fresh QR.
router.post('/status', async (req, res) => {
  const { state, qrDataUrl, phone } = req.body || {}
  if (!['connecting', 'qr', 'online', 'offline'].includes(state)) return res.status(400).json({ error: 'Invalid state' })
  const qr = state === 'qr' && typeof qrDataUrl === 'string' && qrDataUrl.startsWith('data:image/') ? qrDataUrl : null

  const result = await query(
    `UPDATE whatsapp_bot_status
     SET state = $1, qr_data_url = $2, phone = COALESCE($3, phone), updated_at = now(),
         relink_requested = CASE WHEN $1 = 'qr' THEN FALSE ELSE relink_requested END
     WHERE id = 1
     RETURNING relink_requested`,
    [state, qr, phone ? String(phone).slice(0, 40) : null]
  )
  res.json({ relink: !!result.rows[0]?.relink_requested })
})

// GET /bot/groups — groups the bot should talk in, and each one's rules
// (who the group is for, which posts are allowed there).
router.get('/groups', async (req, res) => {
  await ensureGroupSettingsColumn()
  const result = await query(`SELECT jid, settings FROM whatsapp_groups WHERE enabled = TRUE`)
  res.json({
    jids: result.rows.map((r) => r.jid),
    settings: Object.fromEntries(result.rows.map((r) => [r.jid, withGroupDefaults(r.settings)])),
  })
})

// POST /bot/groups  { jid, name, memberCount } — the bot reports a group it
// is in. A group seen for the first time waits under "New groups" in the
// admin app (Bro Paul stays silent there) until a superadmin introduces him
// or starts him quietly; every superadmin gets a push about it.
router.post('/groups', async (req, res) => {
  const { jid, name, memberCount } = req.body || {}
  if (typeof jid !== 'string' || !jid.endsWith('@g.us')) return res.status(400).json({ error: 'Invalid group id' })
  const cleanName = name ? String(name).slice(0, 120) : null
  const count = Number.isInteger(memberCount) ? memberCount : null
  await ensureGroupSettingsColumn()

  const result = await query(
    `INSERT INTO whatsapp_groups (jid, name, member_count, enabled, settings)
     VALUES ($1, $2, $3, FALSE, '{"started": false}'::jsonb)
     ON CONFLICT (jid) DO UPDATE
       SET name = COALESCE(EXCLUDED.name, whatsapp_groups.name),
           member_count = COALESCE(EXCLUDED.member_count, whatsapp_groups.member_count),
           last_seen_at = now()
     RETURNING enabled, (xmax = 0) AS is_new`,
    [jid, cleanName, count]
  )
  const { enabled, is_new: isNew } = result.rows[0]

  if (isNew) {
    const admins = await query(`SELECT id FROM users WHERE role = 'superadmin' AND is_suspended = false`)
    sendPush({
      category: 'updates',
      userIds: admins.rows.map((r) => r.id),
      title: 'Bro Paul joined a new WhatsApp group',
      body: `${cleanName || 'A new group'}${count ? ` (${count} members)` : ''}. He's waiting quietly: tap to introduce him or start him there.`,
      url: '/admin/whatsapp',
      tag: `wa-group-${jid}`,
    }).catch((err) => console.error('New group push failed:', err.message))
  }
  res.json({ enabled, isNew })
})

// ---------- Control Center (superadmin page in the admin app) ----------

// GET /bot/config — feature switches + verified RCF facts. The bot reloads
// this every minute, so changes apply without a redeploy.
// GET /bot/daily — today's verse and study tip, the same ones the app and the
// 7am phone push show, for the bot's morning post in the groups.
router.get('/daily', (req, res) => {
  res.json({ verse: verseOfTheDay(), tip: tipOfTheDay() })
})

router.get('/config', async (req, res) => {
  const [settings, facts] = await Promise.all([
    getBotSettings(),
    query(`SELECT title, text FROM whatsapp_bot_facts ORDER BY created_at ASC LIMIT 100`),
  ])
  res.json({ settings, facts: facts.rows })
})

// GET /bot/outbox — messages a superadmin asked the bot to send.
// kind 'intro' = introduce himself there (the bot writes it from the group's settings).
router.get('/outbox', async (req, res) => {
  await ensureChatLogTables()
  const result = await query(
    `SELECT id, group_jid, text, kind FROM whatsapp_bot_outbox
     WHERE status = 'pending' ORDER BY created_at ASC LIMIT 10`
  )
  res.json({ items: result.rows })
})

// POST /bot/messages  { messages: [{ chatJid, chatType, chatName, senderName, fromBot, kind, text, at }] }
// Conversations for the admin app's Chats tab, batched by the bot.
router.post('/messages', async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(0, 100) : []
  const saved = await saveChatMessages(messages)
  res.json({ saved })
})

// POST /bot/outbox/:id  { status: 'sent' | 'failed', error? }
router.post('/outbox/:id', async (req, res) => {
  const status = req.body?.status === 'sent' ? 'sent' : 'failed'
  const error = status === 'failed' ? String(req.body?.error || 'Unknown error').slice(0, 300) : null
  await query(
    `UPDATE whatsapp_bot_outbox SET status = $2, error = $3, sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE NULL END
     WHERE id = $1 AND status = 'pending'`,
    [req.params.id, status, error]
  )
  res.json({ ok: true })
})

// POST /bot/activity  { events: [{ kind, groupJid, summary }] } — batched
// by the bot. Only the newest ACTIVITY_KEEP rows are kept.
router.post('/activity', async (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 50) : []
  for (const e of events) {
    if (!e?.kind || !e?.summary) continue
    await query(
      `INSERT INTO whatsapp_bot_activity (kind, group_jid, summary) VALUES ($1, $2, $3)`,
      [String(e.kind).slice(0, 30), e.groupJid ? String(e.groupJid).slice(0, 80) : null, String(e.summary).slice(0, 300)]
    )
  }
  if (events.length) {
    await query(
      `DELETE FROM whatsapp_bot_activity WHERE id < (SELECT COALESCE(MIN(id), 0) FROM (
         SELECT id FROM whatsapp_bot_activity ORDER BY id DESC LIMIT $1) newest)`,
      [ACTIVITY_KEEP]
    )
  }
  res.json({ ok: true })
})

export default router
