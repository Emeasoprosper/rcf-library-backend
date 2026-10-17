// RCFMOUAULIBRARYreact/rcf-library-backend/src/services/systemEvents.js
import { query } from '../db/pool.js'

const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const UUID_ONE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KINDS = new Set(['api_error', 'upload_failed', 'ai_failure', 'preview_failed'])
const MAX_BUFFER = 500
const FLUSH_MS = 5000

let buffer = []
let timer = null

async function flush() {
  timer = null
  if (buffer.length === 0) return
  const batch = buffer
  buffer = []

  const values = []
  const params = []
  batch.forEach((e, i) => {
    const o = i * 6
    values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`)
    params.push(e.kind, e.source, e.message, e.status, e.userId, e.resourceId)
  })

  try {
    await query(
      `INSERT INTO system_events (kind, source, message, status, user_id, resource_id) VALUES ${values.join(', ')}`,
      params
    )
  } catch (err) {
    console.warn('Could not save system events:', err.message)
  }
}

// Fire-and-forget. Batches writes every few seconds so an error storm
// can never hammer the database. Never throws.
export function recordEvent({ kind, source = null, message = '', status = null, userId = null, resourceId = null }) {
  if (!KINDS.has(kind)) return
  if (buffer.length >= MAX_BUFFER) buffer.shift()
  buffer.push({
    kind,
    source: source ? String(source).replace(UUID_G, ':id').slice(0, 120) : null,
    message: String(message || '').slice(0, 300),
    status: Number.isInteger(status) ? status : null,
    userId: UUID_ONE.test(String(userId || '')) ? userId : null,
    resourceId: UUID_ONE.test(String(resourceId || '')) ? resourceId : null,
  })
  if (!timer) {
    timer = setTimeout(flush, FLUSH_MS)
    timer.unref?.()
  }
}

// Keep 90 days of events.
const cleanup = setInterval(() => {
  query(`DELETE FROM system_events WHERE created_at < now() - interval '90 days'`).catch(() => {})
}, 24 * 60 * 60 * 1000)
cleanup.unref?.()