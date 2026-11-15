import { query } from '../db/pool.js'

// Material requests can come from WhatsApp: when Bro Paul can't find what
// someone asked for, he files it for the admins. Those people may have no
// library account, so user_id is optional and their WhatsApp id and name
// sit in details ({ source: 'whatsapp', whatsappId, whatsappName, group }).
// When an admin fulfils it, Bro Paul DMs them the link.
let ready = null

export function ensureWhatsappRequests() {
  ready ||= query(`ALTER TABLE material_requests ALTER COLUMN user_id DROP NOT NULL`).catch((err) => {
    ready = null
    throw err
  })
  return ready
}

export function isWhatsappRequest(details) {
  return details?.source === 'whatsapp' && typeof details.whatsappId === 'string'
}

export const SITE_URL = (process.env.PUBLIC_SITE_URL || 'https://rcf-mouau-library.vercel.app').replace(/\/$/, '')

// Many ask for the file to be sent "raw" in the chat. Never a refusal: the
// link is presented as the better deal for them.
export const READ_OFFLINE_NOTE =
  `\n\n📥 Tap the link, sign in and hit download. It saves right inside the app, so you can read it anytime, even offline with zero data, and it won't eat your phone storage or get lost in chats.` +
  `\n📴 Try it: once it's downloaded, switch off your data and open the app. It'll be waiting for you in Downloads.` +
  `\n🤝 We share books through the app rather than as loose files so they stay safe and free for every RCFite, and the people who upload them keep sharing. If anything gives you trouble, just reply here and I'll walk you through it.`

// ---------- "Your book is ready" DMs ----------
// Each finished request is queued with its details (payload) instead of a
// finished message. When Bro Paul collects his outbox, all of one person's
// waiting books go out as ONE message, and the long "how to download and
// read offline" guide is included only once per day; after that he points
// back to it ("the same way I explained earlier today").
let outboxReady = null
export function ensureOutboxColumns() {
  outboxReady ||= query(`
    ALTER TABLE whatsapp_bot_outbox ADD COLUMN IF NOT EXISTS kind TEXT;
    ALTER TABLE whatsapp_bot_outbox ADD COLUMN IF NOT EXISTS payload JSONB;
    ALTER TABLE whatsapp_bot_outbox ADD COLUMN IF NOT EXISTS merged_into UUID;
  `).catch((err) => {
    outboxReady = null
    throw err
  })
  return outboxReady
}

export async function queueReadyDm(whatsappId, { whatsappName, requestTitle, resourceId, resourceTitle, aiWritten = false }, createdBy = null) {
  await ensureOutboxColumns()
  const text = readyMessage({ whatsappName, requestTitle, resourceId, resourceTitle, aiWritten }) // fallback only
  await query(
    `INSERT INTO whatsapp_bot_outbox (group_jid, text, kind, payload, created_by) VALUES ($1, $2, 'request_ready', $3, $4)`,
    [whatsappId, text, JSON.stringify({ whatsappName, requestTitle, resourceId, resourceTitle, aiWritten }), createdBy]
  )
}

const READY_QUIET_MS = 90 * 1000 // wait for more books finishing close together…
const READY_MAX_WAIT_MS = 10 * 60 * 1000 // …but never hold one longer than this

// Turns each person's waiting "ready" rows into one message. Rows still
// inside the quiet window are left for the next collection.
export async function composeReadyDms() {
  await ensureOutboxColumns()
  const pending = await query(
    `SELECT id, group_jid, payload, created_at FROM whatsapp_bot_outbox
     WHERE status = 'pending' AND kind = 'request_ready' AND coalesce(payload->>'composed', '') <> 'true'
     ORDER BY created_at`
  )
  const byJid = new Map()
  for (const row of pending.rows) byJid.set(row.group_jid, [...(byJid.get(row.group_jid) || []), row])

  for (const [jid, rows] of byJid) {
    const newest = Math.max(...rows.map((r) => new Date(r.created_at).getTime()))
    const oldest = Math.min(...rows.map((r) => new Date(r.created_at).getTime()))
    if (Date.now() - newest < READY_QUIET_MS && Date.now() - oldest < READY_MAX_WAIT_MS) continue

    const today = await query(
      `SELECT coalesce(bool_or(payload->>'guide' = 'true'), false) AS guided, count(*)::int AS sent
       FROM whatsapp_bot_outbox
       WHERE group_jid = $1 AND kind = 'request_ready' AND status = 'sent' AND merged_into IS NULL
         AND (sent_at AT TIME ZONE 'Africa/Lagos')::date = (now() AT TIME ZONE 'Africa/Lagos')::date`,
      [jid]
    )
    const { guided, sent } = today.rows[0]
    const items = rows.map((r) => r.payload || {})
    const name = items.find((i) => i.whatsappName)?.whatsappName?.split(' ')[0] || ''
    const hi = name ? ` ${name}` : ''
    const allAi = items.every((i) => i.aiWritten)
    const lines = []
    if (items.length === 1) {
      const i = items[0]
      lines.push(
        sent ? `Another one ready for you${hi}! 🎉` : `Good news${hi}! 🎉`,
        i.aiWritten ? `We wrote full lecture notes for "${i.requestTitle}" ✍️` : `"${i.requestTitle}", which you asked for, is now in the library 📚`
      )
    } else {
      lines.push(
        sent ? `More ready for you${hi}! 🎉` : `Good news${hi}! 🎉`,
        `${items.length} of the ${allAi ? 'lecture notes' : 'materials'} you asked for are ready 📚`
      )
    }
    for (const i of items) {
      lines.push('', `📘 *${i.resourceTitle || i.requestTitle}*`, i.resourceId ? `👉 ${SITE_URL}/library/${i.resourceId}` : `👉 ${SITE_URL}/library`)
    }
    if (!guided) {
      lines.push(READ_OFFLINE_NOTE.trimEnd())
    } else {
      lines.push('', `📥 Download ${items.length > 1 ? 'each one' : 'it'} the same way I explained earlier today ☝️ Tap the link, sign in, hit download, then read offline with zero data.`)
    }
    const text = lines.join('\n').trim()

    const [main, ...rest] = rows
    await query(
      `UPDATE whatsapp_bot_outbox SET text = $2, payload = coalesce(payload, '{}'::jsonb) || $3::jsonb WHERE id = $1`,
      [main.id, text, JSON.stringify({ composed: true, guide: !guided, items: items.length })]
    )
    if (rest.length) {
      await query(
        `UPDATE whatsapp_bot_outbox SET status = 'sent', sent_at = now(), merged_into = $1 WHERE id = ANY($2::uuid[])`,
        [main.id, rest.map((r) => r.id)]
      )
    }
  }
}

// The DM Bro Paul sends when what someone asked for is now in the library.
export function readyMessage({ whatsappName, requestTitle, resourceId, resourceTitle, aiWritten = false }) {
  const name = whatsappName ? ` ${whatsappName.split(' ')[0]}` : ''
  if (!resourceId) {
    return `Good news${name}! 🎉 "${requestTitle}", which you asked for, has been added to the library. Search for it here: ${SITE_URL}/library${READ_OFFLINE_NOTE}`
  }
  const intro = aiWritten
    ? `Good news${name}! 🎉 You asked for "${requestTitle}", so we wrote full lecture notes for you: *${resourceTitle}* ✍️📚\nScheme of work, clear explanations, worked examples, practice questions with answers, and a revision chapter.`
    : `Good news${name}! 🎉 Remember you asked for "${requestTitle}"? It's now in the library: *${resourceTitle}*`
  return `${intro}\n👉 ${SITE_URL}/library/${resourceId}${READ_OFFLINE_NOTE}`
}
