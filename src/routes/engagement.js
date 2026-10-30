// RCFMOUAULIBRARYreact/rcf-library-backend/src/routes/engagement.js
// Reading streaks, the weekly reading goal and badges for the signed-in
// student. Everything is worked out from what the app already records:
// resource_views has one row per student, per resource, per Lagos day.
import { Router } from 'express'
import { query } from '../db/pool.js'
import { attachUser, requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(attachUser, requireAuth)

const GOAL_MIN = 1
const GOAL_MAX = 50

// metric = which number below the badge is measured against.
const BADGES = [
  { key: 'first_steps', icon: 'footprint', title: 'First Steps', desc: 'Open your first resource', metric: 'distinctResources', target: 1, color: 'blue' },
  { key: 'bookworm', icon: 'menu_book', title: 'Bookworm', desc: 'Open 10 different resources', metric: 'distinctResources', target: 10, color: 'green' },
  { key: 'scholar', icon: 'school', title: 'Scholar', desc: 'Open 50 different resources', metric: 'distinctResources', target: 50, color: 'violet' },
  { key: 'streak_3', icon: 'local_fire_department', title: 'On Fire', desc: 'Read 3 days in a row', metric: 'bestStreak', target: 3, color: 'orange' },
  { key: 'streak_7', icon: 'whatshot', title: 'Week Warrior', desc: 'Read 7 days in a row', metric: 'bestStreak', target: 7, color: 'pink' },
  { key: 'streak_30', icon: 'military_tech', title: 'Unstoppable', desc: 'Read 30 days in a row', metric: 'bestStreak', target: 30, color: 'amber' },
  { key: 'finisher', icon: 'task_alt', title: 'Finisher', desc: 'Finish reading a resource', metric: 'completed', target: 1, color: 'teal' },
  { key: 'goal_crusher', icon: 'flag', title: 'Goal Crusher', desc: 'Hit your weekly goal', metric: 'goalWeeks', target: 1, color: 'green' },
  { key: 'collector', icon: 'bookmarks', title: 'Collector', desc: 'Save 5 resources', metric: 'bookmarks', target: 5, color: 'blue' },
  { key: 'offline_ready', icon: 'download_for_offline', title: 'Offline Ready', desc: 'Download 5 resources', metric: 'downloads', target: 5, color: 'slate' },
  { key: 'contributor', icon: 'volunteer_activism', title: 'Contributor', desc: 'Get your first upload approved', metric: 'uploads', target: 1, color: 'pink' },
  { key: 'librarian', icon: 'local_library', title: 'Librarian', desc: 'Get 10 uploads approved', metric: 'uploads', target: 10, color: 'violet' },
  { key: 'voice', icon: 'record_voice_over', title: 'Voice of the People', desc: 'Request a material', metric: 'requests', target: 1, color: 'orange' },
]

export async function loadEngagement(userId) {
  const [stats, islands, week] = await Promise.all([
    query(
      `SELECT
         u.weekly_goal,
         (SELECT COUNT(DISTINCT resource_id) FROM resource_views WHERE user_id = $1)::int AS distinct_resources,
         (SELECT COUNT(*) FROM reading_history WHERE user_id = $1 AND completed_at IS NOT NULL)::int AS completed,
         (SELECT COUNT(*) FROM bookmarks WHERE user_id = $1)::int AS bookmarks,
         (SELECT COUNT(*) FROM downloads WHERE user_id = $1)::int AS downloads,
         (SELECT COUNT(*) FROM resources WHERE uploaded_by = $1 AND status = 'approved')::int AS uploads,
         (SELECT COUNT(*) FROM material_requests WHERE user_id = $1)::int AS requests,
         (SELECT COUNT(*) FROM (
            SELECT date_trunc('week', view_date) FROM resource_views WHERE user_id = $1
            GROUP BY 1 HAVING COUNT(DISTINCT resource_id) >= u.weekly_goal
          ) w)::int AS goal_weeks
       FROM users u WHERE u.id = $1`,
      [userId]
    ),
    // Runs of consecutive reading days ("gaps and islands"), newest first.
    query(
      `WITH days AS (SELECT DISTINCT view_date AS d FROM resource_views WHERE user_id = $1),
            grouped AS (SELECT d, d - (ROW_NUMBER() OVER (ORDER BY d))::int AS g FROM days)
       SELECT MAX(d)::text AS last_day, COUNT(*)::int AS length FROM grouped GROUP BY g ORDER BY last_day DESC`,
      [userId]
    ),
    // This Lagos week, Monday to Sunday.
    query(
      `WITH today AS (SELECT (now() AT TIME ZONE 'Africa/Lagos')::date AS d)
       SELECT (SELECT d FROM today)::text AS today,
              date_trunc('week', (SELECT d FROM today))::date::text AS week_start,
              COALESCE(array_agg(DISTINCT v.view_date::text) FILTER (WHERE v.view_date IS NOT NULL), '{}') AS days,
              COUNT(DISTINCT v.resource_id)::int AS resources
       FROM resource_views v
       WHERE v.user_id = $1 AND v.view_date >= date_trunc('week', (SELECT d FROM today))::date`,
      [userId]
    ),
  ])

  const s = stats.rows[0]
  const w = week.rows[0]
  // Dates arrive as 'YYYY-MM-DD' text (Lagos days) and are handled as UTC
  // midnights, so the server's own timezone can never shift them.
  const dayMs = 86400000
  const utc = (s) => Date.parse(`${s}T00:00:00Z`)
  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10)
  const todayMs = utc(w.today)

  // The current streak is alive if the latest run ended today or yesterday.
  const latest = islands.rows[0]
  const gapDays = latest ? Math.round((todayMs - utc(latest.last_day)) / dayMs) : Infinity
  const current = latest && gapDays <= 1 ? latest.length : 0
  const best = islands.rows.reduce((m, r) => Math.max(m, r.length), 0)

  const readDays = new Set(w.days || [])
  const weekStartMs = utc(w.week_start)
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const ms = weekStartMs + i * dayMs
    const d = ymd(ms)
    return { date: d, read: readDays.has(d), today: ms === todayMs, future: ms > todayMs }
  })

  const metrics = {
    distinctResources: s.distinct_resources,
    bestStreak: best,
    completed: s.completed,
    goalWeeks: s.goal_weeks,
    bookmarks: s.bookmarks,
    downloads: s.downloads,
    uploads: s.uploads,
    requests: s.requests,
  }

  return {
    streak: { current, best, readToday: readDays.has(w.today) },
    week: { goal: s.weekly_goal, done: w.resources, days: weekDays },
    badges: BADGES.map((b) => ({
      key: b.key,
      icon: b.icon,
      title: b.title,
      desc: b.desc,
      color: b.color,
      target: b.target,
      progress: Math.min(metrics[b.metric] || 0, b.target),
      earned: (metrics[b.metric] || 0) >= b.target,
    })),
    totals: metrics,
  }
}

// GET /api/engagement/me
router.get('/me', async (req, res) => {
  res.json(await loadEngagement(req.user.id))
})

// PUT /api/engagement/goal  { goal }
router.put('/goal', async (req, res) => {
  const goal = Number(req.body?.goal)
  if (!Number.isInteger(goal) || goal < GOAL_MIN || goal > GOAL_MAX) {
    return res.status(400).json({ error: `Pick a goal between ${GOAL_MIN} and ${GOAL_MAX}.` })
  }
  await query(`UPDATE users SET weekly_goal = $2 WHERE id = $1`, [req.user.id, goal])
  res.json(await loadEngagement(req.user.id))
})

export default router
