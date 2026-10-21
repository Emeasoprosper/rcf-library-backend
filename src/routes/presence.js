import { Router } from 'express'
import { query } from '../db/pool.js'
import { attachUser, requireAuth } from '../middleware/auth.js'

const router = Router()
const SETTING_KEY = 'online_indicator_enabled'
const STUDY_KEY = 'study_space_enabled'

async function isIndicatorEnabled() {
  const result = await query(`SELECT value FROM app_settings WHERE key = $1`, [SETTING_KEY])
  return result.rows[0]?.value === 'true'
}

// POST /presence/heartbeat — the app calls this about once a minute while
// open and visible. The WHERE clause makes it write at most every 30s per
// user, however often it is called.
router.post('/heartbeat', attachUser, requireAuth, async (req, res) => {
  await query(
    `UPDATE users SET last_seen_at = now()
     WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '30 seconds')`,
    [req.user.id]
  )
  await query(
    `INSERT INTO user_activity_daily (user_id, activity_date)
     VALUES ($1, (now() AT TIME ZONE 'Africa/Lagos')::date)
     ON CONFLICT (user_id, activity_date) DO NOTHING`,
    [req.user.id]
  )
  res.json({ ok: true })
})

// GET /presence — { enabled, online }. The count is only sent when the
// indicator is switched on, or to admins (who always see it).
router.get('/', attachUser, requireAuth, async (req, res) => {
  const enabled = await isIndicatorEnabled()
  const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin'

  let online = null
  if (enabled || isAdmin) {
    const result = await query(
      `SELECT COUNT(*)::int AS count FROM users WHERE last_seen_at > now() - interval '150 seconds'`
    )
    online = result.rows[0].count
  }
  const studyRow = await query(`SELECT value FROM app_settings WHERE key = $1`, [STUDY_KEY])
  res.json({ enabled, online, studyEnabled: studyRow.rows[0]?.value === 'true' })
})

// PATCH /presence/study-space { enabled } — admin switch that shows or
// hides the Study space for students. Off by default.
router.patch('/study-space', attachUser, requireAuth, async (req, res) => {
  const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin'
  if (!isAdmin) return res.status(403).json({ error: 'Admins only' })
  const enabled = Boolean(req.body?.enabled)
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [STUDY_KEY, String(enabled)]
  )
  res.json({ ok: true, enabled })
})

export default router