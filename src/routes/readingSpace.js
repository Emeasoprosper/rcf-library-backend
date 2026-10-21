// rcf-library-backend/src/routes/readingSpace.js
import { Router } from 'express'
import { query } from '../db/pool.js'
import { attachUser, requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(attachUser, requireAuth)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PLANS_PER_USER = 200
const MAX_SESSION_SECONDS = 12 * 60 * 60

function toInt(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(Math.max(Math.round(n), min), max)
}

// GET /reading-space/overview — last 7 Lagos days of study time.
router.get('/overview', async (req, res) => {
  const days = await query(
    `SELECT to_char((started_at AT TIME ZONE 'Africa/Lagos')::date, 'YYYY-MM-DD') AS day,
            SUM(active_seconds)::int AS seconds,
            COUNT(*)::int AS sessions
     FROM study_sessions
     WHERE user_id = $1
       AND active_seconds >= 10
       AND (started_at AT TIME ZONE 'Africa/Lagos')::date >= (now() AT TIME ZONE 'Africa/Lagos')::date - 6
     GROUP BY 1
     ORDER BY 1`,
    [req.user.id]
  )
  const weekSeconds = days.rows.reduce((sum, d) => sum + d.seconds, 0)
  const weekSessions = days.rows.reduce((sum, d) => sum + d.sessions, 0)
  res.json({ days: days.rows, weekSeconds, weekSessions })
})

// POST /reading-space/sessions { resourceId?, page? } — starts a session.
router.post('/sessions', async (req, res) => {
  const { resourceId = null, page = null } = req.body || {}
  if (resourceId !== null) {
    if (!UUID_RE.test(String(resourceId))) return res.status(400).json({ error: 'Invalid resource' })
    const found = await query(`SELECT 1 FROM resources WHERE id = $1 AND status = 'approved'`, [resourceId])
    if (found.rows.length === 0) return res.status(404).json({ error: 'Resource not found' })
  }
  const startPage = page === null ? null : toInt(page, 1, 100000)
  const inserted = await query(
    `INSERT INTO study_sessions (user_id, resource_id, start_page, furthest_page)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [req.user.id, resourceId, startPage]
  )
  res.status(201).json({ id: inserted.rows[0].id })
})

// PATCH /reading-space/sessions/:id { activeSeconds, page? } — heartbeat.
// Active time can never exceed real elapsed time since the session began.
router.patch('/sessions/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid session' })
  const activeSeconds = toInt(req.body?.activeSeconds, 0, MAX_SESSION_SECONDS)
  if (activeSeconds === null) return res.status(400).json({ error: 'activeSeconds is required' })
  const page = req.body?.page == null ? null : toInt(req.body.page, 1, 100000)

  const result = await query(
    `UPDATE study_sessions SET
       active_seconds = GREATEST(active_seconds, LEAST($2::int, (EXTRACT(EPOCH FROM (now() - started_at)))::int + 5)),
       furthest_page = CASE WHEN $3::int IS NULL THEN furthest_page
                            ELSE GREATEST(COALESCE(furthest_page, 0), $3::int) END,
       last_heartbeat_at = now()
     WHERE id = $1 AND user_id = $4
     RETURNING id`,
    [req.params.id, activeSeconds, page, req.user.id]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Session not found' })
  res.json({ ok: true })
})

// GET /reading-space/plans — open plans + ones finished in the last 2 days.
router.get('/plans', async (req, res) => {
  const result = await query(
    `SELECT p.id, p.title, p.planned_start, p.duration_min, p.notes, p.completed_at,
            p.resource_id, r.title AS resource_title
     FROM study_plans p
     LEFT JOIN resources r ON r.id = p.resource_id
     WHERE p.user_id = $1
       AND (p.completed_at IS NULL OR p.completed_at >= now() - interval '2 days')
     ORDER BY (p.completed_at IS NOT NULL), p.planned_start ASC
     LIMIT 100`,
    [req.user.id]
  )
  res.json({ items: result.rows })
})

// POST /reading-space/plans { title, plannedStart, durationMin?, notes?, resourceId? }
router.post('/plans', async (req, res) => {
  const { title, plannedStart, durationMin, notes, resourceId = null } = req.body || {}
  const cleanTitle = String(title || '').trim()
  if (!cleanTitle || cleanTitle.length > 120) {
    return res.status(400).json({ error: 'Title is required (max 120 characters)' })
  }
  const start = new Date(plannedStart)
  if (Number.isNaN(start.getTime())) return res.status(400).json({ error: 'Pick a valid date and time' })
  const duration = toInt(durationMin ?? 30, 5, 600)
  const cleanNotes = notes ? String(notes).trim().slice(0, 500) : null
  if (resourceId !== null && !UUID_RE.test(String(resourceId))) {
    return res.status(400).json({ error: 'Invalid resource' })
  }

  const count = await query(`SELECT COUNT(*)::int AS n FROM study_plans WHERE user_id = $1`, [req.user.id])
  if (count.rows[0].n >= MAX_PLANS_PER_USER) {
    return res.status(400).json({ error: 'You have too many plans. Delete some old ones first.' })
  }

  const inserted = await query(
    `INSERT INTO study_plans (user_id, title, resource_id, planned_start, duration_min, notes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [req.user.id, cleanTitle, resourceId, start.toISOString(), duration, cleanNotes]
  )
  res.status(201).json({ id: inserted.rows[0].id })
})

// PATCH /reading-space/plans/:id { completed: boolean }
router.patch('/plans/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid plan' })
  const completed = req.body?.completed === true
  const result = await query(
    `UPDATE study_plans SET completed_at = CASE WHEN $3 THEN now() ELSE NULL END
     WHERE id = $1 AND user_id = $2 RETURNING id`,
    [req.params.id, req.user.id, completed]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Plan not found' })
  res.json({ ok: true })
})

// DELETE /reading-space/plans/:id
router.delete('/plans/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid plan' })
  await query(`DELETE FROM study_plans WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id])
  res.json({ ok: true })
})

export default router