// RCFMOUAULIBRARYreact/rcf-library-backend/src/routes/adminAnalytics.js
import { Router } from 'express'
import { query, pool } from '../db/pool.js'
import { attachUser, requireAuth, requireRole } from '../middleware/auth.js'
import { getRecentErrors } from '../services/errorLog.js'

const router = Router()
router.use(attachUser, requireAuth, requireRole('admin', 'superadmin'))

const TZ = 'Africa/Lagos'
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_DAYS = 366

const localDate = (col) => `(${col} AT TIME ZONE '${TZ}')::date`
const one = async (sql, params = []) => (await query(sql, params)).rows[0]
const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null)
const share = (n, total) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0)
const kpi = (current, previous) => ({ current, previous, growthPct: pct(current, previous) })

function badRequest(message) {
  const err = new Error(message)
  err.status = 400
  return err
}

async function resolveRange(req) {
  const { from, to } = req.query
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
    throw badRequest('from and to must look like YYYY-MM-DD')
  }
  const row = await one(
    `WITH t AS (SELECT (now() AT TIME ZONE '${TZ}')::date AS today),
          r AS (SELECT COALESCE($2::date, t.today) AS d_to FROM t),
          r2 AS (SELECT d_to, COALESCE($1::date, d_to - 29) AS d_from FROM r)
     SELECT to_char(d_from, 'YYYY-MM-DD') AS "from",
            to_char(d_to, 'YYYY-MM-DD') AS "to",
            (d_to - d_from + 1) AS days,
            to_char(d_from - (d_to - d_from + 1), 'YYYY-MM-DD') AS prev_from,
            to_char(d_from - 1, 'YYYY-MM-DD') AS prev_to
     FROM r2`,
    [from || null, to || null]
  )
  const days = Number(row.days)
  if (days < 1 || days > MAX_DAYS) throw badRequest('Date range must be between 1 and 366 days')
  return { from: row.from, to: row.to, days, prevFrom: row.prev_from, prevTo: row.prev_to }
}

const newUsersBetween = async (a, b) =>
  (await one(`SELECT COUNT(*)::int AS c FROM users WHERE ${localDate('created_at')} BETWEEN $1::date AND $2::date`, [a, b])).c

const activeBetween = async (a, b) =>
  (await one(`SELECT COUNT(DISTINCT user_id)::int AS c FROM user_activity_daily WHERE activity_date BETWEEN $1::date AND $2::date`, [a, b])).c

// Active users in the N days ending on `end` (N=1 is a single day).
const activeWindow = async (end, n) =>
  (await one(
    `SELECT COUNT(DISTINCT user_id)::int AS c FROM user_activity_daily
     WHERE activity_date BETWEEN ($1::date - ($2::int - 1)) AND $1::date`,
    [end, n]
  )).c

const returningBetween = async (a, b) =>
  (await one(
    `SELECT COUNT(DISTINCT a.user_id)::int AS c
     FROM user_activity_daily a JOIN users u ON u.id = a.user_id
     WHERE a.activity_date BETWEEN $1::date AND $2::date
       AND ${localDate('u.created_at')} < $1::date`,
    [a, b]
  )).c

const downloadsBetween = async (a, b) =>
  one(
    `SELECT COUNT(*)::int AS events, COUNT(DISTINCT user_id)::int AS users
     FROM downloads WHERE ${localDate('downloaded_at')} BETWEEN $1::date AND $2::date`,
    [a, b]
  )

const viewsBetween = async (a, b) =>
  one(
    `SELECT COUNT(*)::int AS events, COUNT(DISTINCT user_id)::int AS users
     FROM resource_views WHERE ${localDate('viewed_at')} BETWEEN $1::date AND $2::date`,
    [a, b]
  )

// Every category a resource has, from BOTH places it can be stored.
const CAT_PAIRS = `(SELECT resource_id, category_id FROM resource_categories
                    UNION
                    SELECT id AS resource_id, category_id FROM resources WHERE category_id IS NOT NULL)`

// GET /admin/analytics/overview?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/overview', async (req, res) => {
  const { from, to, days, prevFrom, prevTo } = await resolveRange(req)

  const [
    totalUsersRow, newCur, newPrev, activeCur, activePrev, retCur, retPrev,
    dlCur, dlPrev, vwCur, vwPrev, dau, dauPrev, wau, wauPrev, mau, mauPrev,
  ] = await Promise.all([
    one(`SELECT COUNT(*)::int AS c FROM users`),
    newUsersBetween(from, to), newUsersBetween(prevFrom, prevTo),
    activeBetween(from, to), activeBetween(prevFrom, prevTo),
    returningBetween(from, to), returningBetween(prevFrom, prevTo),
    downloadsBetween(from, to), downloadsBetween(prevFrom, prevTo),
    viewsBetween(from, to), viewsBetween(prevFrom, prevTo),
    activeWindow(to, 1), activeWindow(prevTo, 1),
    activeWindow(to, 7), activeWindow(prevTo, 7),
    activeWindow(to, 30), activeWindow(prevTo, 30),
  ])

  const series = (await query(
    `SELECT to_char(g.d::date, 'YYYY-MM-DD') AS date,
            COALESCE(reg.c, 0)::int AS registrations,
            COALESCE(act.c, 0)::int AS active_users,
            COALESCE(dl.c, 0)::int AS downloads,
            COALESCE(vw.c, 0)::int AS views,
            (SELECT COUNT(*)::int FROM users u WHERE ${localDate('u.created_at')} <= g.d::date) AS total_users
     FROM generate_series($1::date, $2::date, interval '1 day') AS g(d)
     LEFT JOIN (SELECT ${localDate('created_at')} AS day, COUNT(*) AS c FROM users
                WHERE ${localDate('created_at')} BETWEEN $1::date AND $2::date GROUP BY 1) reg ON reg.day = g.d::date
     LEFT JOIN (SELECT activity_date AS day, COUNT(*) AS c FROM user_activity_daily
                WHERE activity_date BETWEEN $1::date AND $2::date GROUP BY 1) act ON act.day = g.d::date
     LEFT JOIN (SELECT ${localDate('downloaded_at')} AS day, COUNT(*) AS c FROM downloads
                WHERE ${localDate('downloaded_at')} BETWEEN $1::date AND $2::date GROUP BY 1) dl ON dl.day = g.d::date
     LEFT JOIN (SELECT ${localDate('viewed_at')} AS day, COUNT(*) AS c FROM resource_views
                WHERE ${localDate('viewed_at')} BETWEEN $1::date AND $2::date GROUP BY 1) vw ON vw.day = g.d::date
     ORDER BY g.d`,
    [from, to]
  )).rows.map((r) => ({
    date: r.date, registrations: r.registrations, activeUsers: r.active_users,
    downloads: r.downloads, views: r.views, totalUsers: r.total_users,
  }))

  const [topDownloaded, topViewed, mostViewedLifetime, categoryDownloads, retentionRows, tracking] = await Promise.all([
    query(
      `SELECT r.id, r.title, rt.label AS type, COUNT(d.id)::int AS downloads
       FROM downloads d JOIN resources r ON r.id = d.resource_id
       JOIN resource_types rt ON rt.id = r.resource_type_id
       WHERE ${localDate('d.downloaded_at')} BETWEEN $1::date AND $2::date
       GROUP BY r.id, rt.label ORDER BY downloads DESC, r.title LIMIT 10`,
      [from, to]
    ),
    query(
      `SELECT r.id, r.title, rt.label AS type, COUNT(v.id)::int AS views
       FROM resource_views v JOIN resources r ON r.id = v.resource_id
       JOIN resource_types rt ON rt.id = r.resource_type_id
       WHERE ${localDate('v.viewed_at')} BETWEEN $1::date AND $2::date
       GROUP BY r.id, rt.label ORDER BY views DESC, r.title LIMIT 10`,
      [from, to]
    ),
    query(
      `SELECT r.id, r.title, rt.label AS type, r.view_count AS views
       FROM resources r JOIN resource_types rt ON rt.id = r.resource_type_id
       WHERE r.status = 'approved' AND r.view_count > 0
       ORDER BY r.view_count DESC LIMIT 10`
    ),
    query(
      `SELECT c.name, COUNT(d.id)::int AS downloads
       FROM downloads d
       JOIN ${CAT_PAIRS} rc ON rc.resource_id = d.resource_id
       JOIN categories c ON c.id = rc.category_id
       WHERE ${localDate('d.downloaded_at')} BETWEEN $1::date AND $2::date
       GROUP BY c.name ORDER BY downloads DESC, c.name LIMIT 12`,
      [from, to]
    ),
    query(
      `WITH today AS (SELECT (now() AT TIME ZONE '${TZ}')::date AS d),
            first_day AS (SELECT user_id, MIN(activity_date) AS d0 FROM user_activity_daily GROUP BY user_id),
            marks AS (
              SELECT f.user_id, f.d0, n.n,
                     EXISTS (SELECT 1 FROM user_activity_daily a
                             WHERE a.user_id = f.user_id AND a.activity_date = f.d0 + n.n) AS came_back
              FROM first_day f CROSS JOIN (VALUES (1), (7), (30)) AS n(n)
            )
       SELECT m.n AS day,
              COUNT(*) FILTER (WHERE m.d0 <= t.d - m.n)::int AS cohort,
              COUNT(*) FILTER (WHERE m.d0 <= t.d - m.n AND m.came_back)::int AS retained
       FROM marks m CROSS JOIN today t
       GROUP BY m.n, t.d ORDER BY m.n`
    ),
    one(
      `SELECT (SELECT to_char(MIN(activity_date), 'YYYY-MM-DD') FROM user_activity_daily) AS activity_since,
              (SELECT to_char(MIN(viewed_at AT TIME ZONE '${TZ}'), 'YYYY-MM-DD') FROM resource_views) AS views_since`
    ),
  ])

  const retention = [1, 7, 30].map((day) => {
    const row = retentionRows.rows.find((r) => r.day === day) || { cohort: 0, retained: 0 }
    return {
      day, cohort: row.cohort, retained: row.retained,
      ratePct: row.cohort > 0 ? Math.round((row.retained / row.cohort) * 1000) / 10 : null,
    }
  })

  res.json({
    range: { from, to, days, prevFrom, prevTo },
    kpis: {
      totalUsers: totalUsersRow.c,
      newRegistrations: kpi(newCur, newPrev),
      activeUsers: kpi(activeCur, activePrev),
      returningUsers: kpi(retCur, retPrev),
      newActiveUsers: kpi(Math.max(activeCur - retCur, 0), Math.max(activePrev - retPrev, 0)),
      dau: kpi(dau, dauPrev),
      wau: kpi(wau, wauPrev),
      mau: kpi(mau, mauPrev),
      stickinessPct: mau > 0 ? Math.round((dau / mau) * 1000) / 10 : null,
      downloads: kpi(dlCur.events, dlPrev.events),
      uniqueDownloaders: kpi(dlCur.users, dlPrev.users),
      views: kpi(vwCur.events, vwPrev.events),
    },
    series,
    topDownloaded: topDownloaded.rows,
    topViewed: topViewed.rows,
    mostViewedLifetime: mostViewedLifetime.rows,
    categoryDownloads: categoryDownloads.rows,
    retention,
    tracking: { activitySince: tracking.activity_since, viewsSince: tracking.views_since },
  })
})

// GET /admin/analytics/resources
router.get('/resources', async (req, res) => {
  const [statusRows, typeRows, catRows, uncat, dlType, dlCat, growthRows, preview] = await Promise.all([
    query(`SELECT status::text AS status, COUNT(*)::int AS count FROM resources GROUP BY status`),
    query(
      `SELECT rt.slug, rt.label, COUNT(r.id)::int AS total,
              COUNT(r.id) FILTER (WHERE r.status = 'approved')::int AS approved
       FROM resource_types rt LEFT JOIN resources r ON r.resource_type_id = rt.id
       GROUP BY rt.id, rt.slug, rt.label ORDER BY total DESC, rt.label`
    ),
    query(
      `SELECT c.name, COUNT(DISTINCT rc.resource_id)::int AS count
       FROM ${CAT_PAIRS} rc
       JOIN categories c ON c.id = rc.category_id
       JOIN resources r ON r.id = rc.resource_id AND r.status = 'approved'
       GROUP BY c.name ORDER BY count DESC, c.name LIMIT 30`
    ),
    one(
      `SELECT COUNT(*)::int AS c FROM resources r
       WHERE r.status = 'approved'
         AND NOT EXISTS (SELECT 1 FROM ${CAT_PAIRS} rc WHERE rc.resource_id = r.id)`
    ),
    query(
      `SELECT rt.label, COUNT(d.id)::int AS downloads
       FROM downloads d JOIN resources r ON r.id = d.resource_id
       JOIN resource_types rt ON rt.id = r.resource_type_id
       GROUP BY rt.label ORDER BY downloads DESC`
    ),
    query(
      `SELECT c.name, COUNT(d.id)::int AS downloads
       FROM downloads d
       JOIN ${CAT_PAIRS} rc ON rc.resource_id = d.resource_id
       JOIN categories c ON c.id = rc.category_id
       GROUP BY c.name ORDER BY downloads DESC, c.name LIMIT 15`
    ),
    query(
      `SELECT to_char(date_trunc('month', created_at AT TIME ZONE '${TZ}'), 'YYYY-MM') AS month,
              COUNT(*)::int AS uploaded,
              COUNT(*) FILTER (WHERE status = 'approved')::int AS approved
       FROM resources GROUP BY 1 ORDER BY 1`
    ),
    one(
      `SELECT COUNT(*) FILTER (WHERE thumbnail_status = 'unavailable')::int AS failed,
              COUNT(*) FILTER (WHERE thumbnail_status IN ('pending', 'processing'))::int AS in_progress
       FROM resources`
    ),
  ])

  const byStatus = { pending: 0, approved: 0, rejected: 0 }
  for (const r of statusRows.rows) byStatus[r.status] = r.count
  const total = byStatus.pending + byStatus.approved + byStatus.rejected

  let runUploaded = 0
  let runApproved = 0
  const growth = growthRows.rows.map((r) => {
    runUploaded += r.uploaded
    runApproved += r.approved
    return { ...r, cumulativeUploaded: runUploaded, cumulativeApproved: runApproved }
  })

  res.json({
    totals: { all: total, ...byStatus },
    byType: typeRows.rows.map((r) => ({ ...r, percentOfAll: share(r.total, total) })),
    byCategory: {
      approvedTotal: byStatus.approved,
      items: catRows.rows.map((r) => ({ ...r, percentOfApproved: share(r.count, byStatus.approved) })),
      uncategorised: uncat.c,
      note: 'A resource with several categories is counted once in each, so these bars can add up to more than the total.',
    },
    downloadsByType: dlType.rows,
    downloadsByCategory: dlCat.rows,
    growth,
    preview: { failed: preview.failed, inProgress: preview.in_progress },
    failedUploads: null, // not recorded anywhere yet
  })
})

// GET /admin/analytics/system
router.get('/system', async (req, res) => {
  const started = Date.now()
  await query('SELECT 1')
  const errors = getRecentErrors()
  res.json({
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    nodeVersion: process.version,
    dbLatencyMs: Date.now() - started,
    dbPool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    errorsSinceRestart: errors.length,
    lastErrorAt: errors[0]?.at || null,
  })
})

// GET /admin/analytics/events?from=&to= — failures saved by recordEvent().
router.get('/events', async (req, res) => {
  const { from, to, days, prevFrom, prevTo } = await resolveRange(req)

  const countsBetween = async (a, b) => {
    const rows = (await query(
      `SELECT kind, COUNT(*)::int AS count FROM system_events
       WHERE ${localDate('created_at')} BETWEEN $1::date AND $2::date GROUP BY kind`,
      [a, b]
    )).rows
    const out = { api_error: 0, upload_failed: 0, ai_failure: 0, preview_failed: 0 }
    for (const r of rows) out[r.kind] = r.count
    return out
  }

  const [totals, previousTotals, seriesRows, recent, since] = await Promise.all([
    countsBetween(from, to),
    countsBetween(prevFrom, prevTo),
    query(
      `SELECT to_char(g.d::date, 'YYYY-MM-DD') AS date,
              COUNT(e.id) FILTER (WHERE e.kind = 'api_error')::int AS api_error,
              COUNT(e.id) FILTER (WHERE e.kind = 'upload_failed')::int AS upload_failed,
              COUNT(e.id) FILTER (WHERE e.kind = 'ai_failure')::int AS ai_failure,
              COUNT(e.id) FILTER (WHERE e.kind = 'preview_failed')::int AS preview_failed
       FROM generate_series($1::date, $2::date, interval '1 day') AS g(d)
       LEFT JOIN system_events e ON ${localDate('e.created_at')} = g.d::date
       GROUP BY g.d ORDER BY g.d`,
      [from, to]
    ),
    query(
      `SELECT kind, source, message, status,
              to_char(created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD HH24:MI') AS at
       FROM system_events
       WHERE ${localDate('created_at')} BETWEEN $1::date AND $2::date
       ORDER BY created_at DESC LIMIT 25`,
      [from, to]
    ),
    one(`SELECT to_char(MIN(created_at AT TIME ZONE '${TZ}'), 'YYYY-MM-DD') AS since FROM system_events`),
  ])

  res.json({
    range: { from, to, days },
    totals,
    previousTotals,
    series: seriesRows.rows,
    recent: recent.rows,
    since: since.since,
  })
})

export default router