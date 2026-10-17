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

// ---------- Activity history (daily / weekly / monthly) ----------
const GRAN = {
  daily: ['day', '1 day', 14, 60],
  weekly: ['week', '1 week', 12, 52],
  monthly: ['month', '1 month', 12, 24],
}

// GET /admin/analytics/activity?granularity=daily|weekly|monthly&count=N
router.get('/activity', async (req, res) => {
  const cfg = GRAN[req.query.granularity]
  if (!cfg) throw badRequest('granularity must be daily, weekly or monthly')
  const [unit, step, defCount, maxCount] = cfg
  const count = Math.min(Math.max(parseInt(req.query.count, 10) || defCount, 1), maxCount)

  const rows = (await query(
    `WITH buckets AS (
       SELECT g.d::date AS start, (g.d + interval '${step}' - interval '1 day')::date AS finish
       FROM generate_series(
              date_trunc('${unit}', now() AT TIME ZONE '${TZ}') - ${count - 1} * interval '${step}',
              date_trunc('${unit}', now() AT TIME ZONE '${TZ}'),
              interval '${step}') AS g(d)
     ),
     span AS (SELECT MIN(start) AS s, MAX(finish) AS f FROM buckets),
     reg AS (SELECT ${localDate('created_at')} AS day, COUNT(*)::int AS c FROM users, span
             WHERE ${localDate('created_at')} BETWEEN span.s AND span.f GROUP BY 1),
     dl AS (SELECT ${localDate('downloaded_at')} AS day, COUNT(*)::int AS c FROM downloads, span
            WHERE ${localDate('downloaded_at')} BETWEEN span.s AND span.f GROUP BY 1),
     vw AS (SELECT ${localDate('viewed_at')} AS day, COUNT(*)::int AS c FROM resource_views, span
            WHERE ${localDate('viewed_at')} BETWEEN span.s AND span.f GROUP BY 1)
     SELECT to_char(b.start, 'YYYY-MM-DD') AS start,
            to_char(b.finish, 'YYYY-MM-DD') AS finish,
            (SELECT COUNT(DISTINCT a.user_id)::int FROM user_activity_daily a
              WHERE a.activity_date BETWEEN b.start AND b.finish) AS active_users,
            COALESCE((SELECT SUM(c) FROM reg WHERE reg.day BETWEEN b.start AND b.finish), 0)::int AS registrations,
            COALESCE((SELECT SUM(c) FROM dl WHERE dl.day BETWEEN b.start AND b.finish), 0)::int AS downloads,
            COALESCE((SELECT SUM(c) FROM vw WHERE vw.day BETWEEN b.start AND b.finish), 0)::int AS views,
            (b.finish >= (now() AT TIME ZONE '${TZ}')::date) AS in_progress
     FROM buckets b ORDER BY b.start`
  )).rows

  res.json({
    granularity: req.query.granularity,
    count,
    items: rows.map((r) => ({
      start: r.start, finish: r.finish, activeUsers: r.active_users,
      registrations: r.registrations, downloads: r.downloads, views: r.views, inProgress: r.in_progress,
    })),
  })
})

// ---------- Checkup (plain-language health and growth verdicts) ----------
const MB = 1048576
// Defaults match the plans you are on today. Change them on Render with
// DB_SIZE_LIMIT_MB, SERVER_MEMORY_LIMIT_MB and DRIVE_STORAGE_LIMIT_GB if
// you upgrade any of them.
const LIMITS = {
  dbMb: Number(process.env.DB_SIZE_LIMIT_MB) || 500,
  memMb: Number(process.env.SERVER_MEMORY_LIMIT_MB) || 512,
  driveGb: Number(process.env.DRIVE_STORAGE_LIMIT_GB) || 15,
}
const nf = (n) => Number(n).toLocaleString()
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)
const fmtSize = (b) =>
  b >= 1024 * MB ? `${(b / (1024 * MB)).toFixed(2)} GB` : `${(b / MB).toFixed(b < 10 * MB ? 1 : 0)} MB`
const capacityLevel = (usedPct) => (usedPct >= 85 ? 'critical' : usedPct >= 70 ? 'watch' : 'good')

function addTrend(add, area, label, cur, prev) {
  const small = Math.max(cur, prev) < 10 ? ' These are small numbers, so one busy day can swing them.' : ''
  if (cur === 0 && prev === 0) {
    return add(area, 'watch', `No ${label} in 14 days`, `There were no ${label} in the last 14 days.`)
  }
  if (prev === 0) {
    return add(area, 'good', `${cap(label)} are picking up`, `${nf(cur)} ${label} in the last 7 days, against none in the 7 days before.${small}`)
  }
  const change = Math.round(((cur - prev) / prev) * 100)
  const base = `${nf(cur)} ${label} in the last 7 days against ${nf(prev)} in the 7 days before (${change > 0 ? '+' : ''}${change}%).${small}`
  if (change >= 10) return add(area, 'good', `${cap(label)} are growing`, base)
  if (change <= -10) {
    return add(area, 'watch', `${cap(label)} are slowing down`, `${base} Worth checking whether something changed, such as a school break, exams, or fewer people sharing the link.`)
  }
  return add(area, 'info', `${cap(label)} are steady`, base)
}

// GET /admin/analytics/insights
router.get('/insights', async (req, res) => {
  const items = []
  const add = (area, level, title, detail, usedPct = null) => items.push({ area, level, title, detail, percent: usedPct })
  const safe = async (label, fn) => {
    try {
      await fn()
    } catch (err) {
      console.warn(`Checkup step failed (${label}):`, err.message)
      add('health', 'info', `Could not check ${label}`, 'This check failed. The server log has the reason.')
    }
  }

  // Full days only (today is still in progress, so it would skew every comparison).
  const d = await one(
    `SELECT to_char(t, 'YYYY-MM-DD') AS today, to_char(t - 7, 'YYYY-MM-DD') AS w_from,
            to_char(t - 1, 'YYYY-MM-DD') AS w_to, to_char(t - 14, 'YYYY-MM-DD') AS p_from,
            to_char(t - 8, 'YYYY-MM-DD') AS p_to, to_char(t - 30, 'YYYY-MM-DD') AS m_from
     FROM (SELECT (now() AT TIME ZONE '${TZ}')::date AS t) x`
  )
  const hist = await one(`SELECT (now() AT TIME ZONE '${TZ}')::date - MIN(activity_date) AS days FROM user_activity_daily`)
  const historyDays = hist.days == null ? 0 : Number(hist.days)

  // ---- Growth: is the app being noticed? ----
  await safe('registrations', async () => {
    const [cur, prev] = await Promise.all([newUsersBetween(d.w_from, d.w_to), newUsersBetween(d.p_from, d.p_to)])
    addTrend(add, 'growth', 'new registrations', cur, prev)
  })
  await safe('downloads', async () => {
    const [cur, prev] = await Promise.all([downloadsBetween(d.w_from, d.w_to), downloadsBetween(d.p_from, d.p_to)])
    addTrend(add, 'growth', 'downloads', cur.events, prev.events)
  })
  add('growth', 'info', 'Google search traffic is not measured here',
    'This dashboard only sees people who open the app. How many pages Google has indexed, and how many people found you through it, is in Search Console (Pages and Performance reports).')

  // ---- Engagement: are people coming back? ----
  await safe('activity', async () => {
    if (historyDays < 14) {
      add('engagement', 'info', 'Not enough activity history yet',
        `Active-user tracking has ${historyDays} day(s) of data. Week-on-week comparisons make sense after 14 days, and stickiness after 30.`)
      return
    }
    const [cur, prev] = await Promise.all([activeBetween(d.w_from, d.w_to), activeBetween(d.p_from, d.p_to)])
    addTrend(add, 'engagement', 'active users', cur, prev)

    if (historyDays >= 30) {
      const avgRow = await one(
        `SELECT COALESCE(SUM(c), 0)::float / 7 AS a FROM (
           SELECT activity_date, COUNT(*) AS c FROM user_activity_daily
           WHERE activity_date BETWEEN $1::date AND $2::date GROUP BY 1) x`,
        [d.w_from, d.w_to]
      )
      const mau = await activeBetween(d.m_from, d.w_to)
      const stick = mau > 0 ? Math.round((avgRow.a / mau) * 1000) / 10 : 0
      const detail = `On an average day about ${Math.round(avgRow.a)} of the ${nf(mau)} people who used the app in the last 30 days came back (${stick}%). Rule of thumb: 20% or more is strong, under 10% means most people visit rarely.`
      add('engagement', stick >= 20 ? 'good' : stick >= 10 ? 'info' : 'watch', 'How often people come back', detail)
    } else {
      add('engagement', 'info', 'Stickiness needs 30 days of history', `Activity tracking has ${historyDays} days of data so far.`)
    }

    const r = await one(
      `WITH first_day AS (SELECT user_id, MIN(activity_date) AS d0 FROM user_activity_daily GROUP BY user_id)
       SELECT COUNT(*) FILTER (WHERE d0 <= $1::date - 7)::int AS cohort,
              COUNT(*) FILTER (WHERE d0 <= $1::date - 7 AND EXISTS (
                SELECT 1 FROM user_activity_daily a WHERE a.user_id = first_day.user_id AND a.activity_date = first_day.d0 + 7))::int AS retained
       FROM first_day`,
      [d.today]
    )
    if (r.cohort < 10) {
      add('engagement', 'info', 'Day-7 retention needs more users', `Only ${r.cohort} users first appeared 7 or more days ago. It needs at least 10 to mean anything.`)
    } else {
      const rate = Math.round((r.retained / r.cohort) * 1000) / 10
      add('engagement', rate >= 20 ? 'good' : rate >= 10 ? 'info' : 'watch', `${rate}% came back a week after their first visit`,
        `${nf(r.retained)} of ${nf(r.cohort)} users were active again exactly 7 days after their first day. Rule of thumb: 20% or more is a healthy sign for a study app.`)
    }
  })
  await safe('people online', async () => {
    const o = await one(`SELECT COUNT(*)::int AS c FROM users WHERE last_seen_at > now() - interval '150 seconds'`)
    add('engagement', 'info', 'People online right now', `${nf(o.c)} signed-in ${o.c === 1 ? 'person is' : 'people are'} using the app at this moment.`)
  })

  // ---- Health: is anything breaking? ----
  await safe('failure log', async () => {
    const total = await one(`SELECT COUNT(*)::int AS c FROM system_events`)
    if (total.c === 0) {
      add('health', 'info', 'Failure log is empty',
        'Nothing has been logged yet. That is good news if people have used the app since this update, but the log only started recording when this version went live.')
      return
    }
    const rows = (await query(
      `SELECT kind, COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS d1, COUNT(*)::int AS d7
       FROM system_events WHERE created_at > now() - interval '7 days' GROUP BY kind`
    )).rows
    const get = (k) => rows.find((r) => r.kind === k) || { d1: 0, d7: 0 }

    const a = get('api_error')
    const baseline = (a.d7 - a.d1) / 6
    if (a.d1 >= 10 && a.d1 > 3 * baseline) {
      add('health', 'critical', 'API errors spiked', `${nf(a.d1)} errors in the last 24 hours, against about ${Math.round(baseline)} a day before. Open the Health tab to see the latest ones.`)
    } else if (a.d1 >= 10) {
      add('health', 'watch', 'API errors are elevated', `${nf(a.d1)} errors in 24 hours (${nf(a.d7)} in 7 days). Open the Health tab to see what they were.`)
    } else if (a.d7 === 0) {
      add('health', 'good', 'No API errors this week', 'Nothing was logged in the last 7 days.')
    } else {
      add('health', 'info', 'A few API errors', `${nf(a.d1)} in 24 hours, ${nf(a.d7)} in 7 days. Open the Health tab to see what they were.`)
    }

    const u = get('upload_failed')
    if (u.d7 > 0) add('health', 'watch', 'Some uploads failed', `${nf(u.d7)} upload(s) failed on the server in the last 7 days. Open the Health tab for the reasons.`)
    else add('health', 'good', 'No failed uploads this week', 'Every upload that reached the server went through.')

    const ai = get('ai_failure')
    if (ai.d7 > 0) add('health', 'watch', 'AI auto-fill is failing sometimes', `${nf(ai.d7)} failure(s) in 7 days. Uploads still work, but the form will not auto-fill. This is often an AI key or quota problem.`)
    else add('health', 'good', 'AI auto-fill is working', 'No AI failures in the last 7 days.')

    const pv = get('preview_failed')
    if (pv.d7 > 0) add('health', 'watch', 'Some previews failed to generate', `${nf(pv.d7)} in 7 days. Those resources fall back to a generated cover.`)
  })
  await safe('thumbnails', async () => {
    const t = await one(`SELECT COUNT(*)::int AS c FROM resources WHERE thumbnail_status = 'unavailable' AND status <> 'rejected'`)
    if (t.c > 0) add('health', 'watch', `${nf(t.c)} resource(s) have no real thumbnail`, 'Their previews could not be generated, so readers see no cover image.')
  })
  await safe('review backlog', async () => {
    const p = await one(
      `SELECT COUNT(*)::int AS c, COALESCE(EXTRACT(EPOCH FROM (now() - MIN(created_at))) / 86400, 0)::float AS oldest
       FROM resources WHERE status = 'pending'`
    )
    if (p.c === 0) add('health', 'good', 'No uploads waiting for review', 'Every upload has been reviewed.')
    else if (p.oldest > 7) add('health', 'watch', 'Uploads are waiting a long time', `${nf(p.c)} waiting for review, the oldest for ${Math.floor(p.oldest)} days. Contributors may lose interest if approvals are slow.`)
    else add('health', 'info', `${nf(p.c)} upload(s) waiting for review`, `The oldest has waited about ${Math.max(1, Math.round(p.oldest))} day(s).`)
  })

  // ---- Limits: will something run out? ----
  await safe('database size', async () => {
    const size = await one(`SELECT pg_database_size(current_database())::bigint AS b`)
    const used = Number(size.b)
    const usedPct = Math.round((used / (LIMITS.dbMb * MB)) * 1000) / 10
    const tables = (await query(
      `SELECT c.relname AS name, pg_total_relation_size(c.oid)::bigint AS b
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY b DESC LIMIT 3`
    )).rows
    add('capacity', capacityLevel(usedPct), `Database is ${usedPct}% full`,
      `${fmtSize(used)} used of about ${LIMITS.dbMb} MB. Biggest tables: ${tables.map((t) => `${t.name} (${fmtSize(Number(t.b))})`).join(', ')}. Going past the limit means upgrading the plan or trimming data.`,
      usedPct)
  })
  await safe('file storage', async () => {
    const s = await one(
      `SELECT COALESCE(SUM(file_size_bytes), 0)::bigint AS used,
              COALESCE(MAX(file_size_bytes), 0)::bigint AS biggest,
              COUNT(*) FILTER (WHERE file_size_bytes > ${50 * MB})::int AS big,
              COALESCE(SUM(file_size_bytes) FILTER (WHERE created_at > now() - interval '30 days'), 0)::bigint AS added30
       FROM resources WHERE status <> 'rejected'`
    )
    const used = Number(s.used)
    const limitBytes = LIMITS.driveGb * 1024 * MB
    const usedPct = Math.round((used / limitBytes) * 1000) / 10
    let level = capacityLevel(usedPct)
    let pace = ''
    const perDay = Number(s.added30) / 30
    if (perDay > 0) {
      const daysLeft = Math.floor((limitBytes - used) / perDay)
      if (daysLeft > 0 && daysLeft < 730) pace = ` At the pace of the last 30 days (about ${fmtSize(perDay)} a day) it would fill in roughly ${nf(daysLeft)} days.`
      if (daysLeft < 30) level = 'critical'
      else if (daysLeft < 90 && level === 'good') level = 'watch'
    }
    add('capacity', level, `File storage is ${usedPct}% full`,
      `${fmtSize(used)} of uploaded files out of about ${LIMITS.driveGb} GB. This counts the files only (not thumbnails), and a Google account's storage is shared with its Gmail and Photos.${pace}`,
      usedPct)

    if (Number(s.biggest) > 50 * MB) {
      const memBytes = LIMITS.memMb * MB
      add('capacity', Number(s.biggest) >= 0.4 * memBytes ? 'critical' : 'watch', 'Large files can exhaust server memory',
        `Your largest file is ${fmtSize(Number(s.biggest))} and ${nf(s.big)} file(s) are over 50 MB. The server reads a whole file into memory each time someone opens or downloads it, so a few people opening big files at the same time can run it out of memory and restart it.`)
    }
  })

  const rss = process.memoryUsage().rss
  const memPct = Math.round((rss / (LIMITS.memMb * MB)) * 1000) / 10
  add('capacity', capacityLevel(memPct), `Server memory is at ${memPct}%`,
    `${fmtSize(rss)} in use right now of about ${LIMITS.memMb} MB. This is a snapshot. Memory spikes while big files are uploaded, previewed or streamed, and if it reaches the limit the server process is killed and restarted.`,
    memPct)

  await safe('database speed', async () => {
    const times = []
    for (let i = 0; i < 3; i += 1) {
      const t = Date.now()
      await query('SELECT 1')
      times.push(Date.now() - t)
    }
    times.sort((x, y) => x - y)
    const med = times[1]
    add('capacity', med < 250 ? 'good' : med < 800 ? 'watch' : 'critical', `Database answers in ${med} ms`,
      'Measured from the server to the database. Slow answers usually mean the database is busy or far from the server.')
  })
  const max = pool.options?.max ?? 10
  if (pool.waitingCount > 0 || (pool.totalCount >= max && pool.idleCount === 0)) {
    add('capacity', 'watch', 'Requests are queuing for the database', `${pool.waitingCount} waiting, ${pool.totalCount} of ${max} connections busy.`)
  } else {
    add('capacity', 'good', 'Database connections are fine', `${pool.totalCount} of ${max} connections open, ${pool.idleCount} idle, none waiting.`)
  }

  const counts = { critical: 0, watch: 0, good: 0, info: 0 }
  for (const i of items) counts[i.level] += 1
  const goodTitles = items.filter((i) => i.level === 'good').slice(0, 2).map((i) => i.title.toLowerCase())
  const praise = counts.good > 0 ? `Going well: ${goodTitles.join('; ')}${counts.good > 2 ? `, and ${counts.good - 2} more` : ''}.` : null

  let summary
  if (counts.critical > 0) {
    summary = { level: 'critical', headline: 'Needs attention', detail: `${counts.critical} thing(s) should be fixed soon, and ${counts.watch} more are worth watching.`, praise }
  } else if (counts.watch > 0) {
    summary = { level: 'watch', headline: 'Mostly healthy, with a few things to watch', detail: `${counts.watch} thing(s) to keep an eye on. Nothing is urgent.`, praise }
  } else {
    summary = { level: 'good', headline: 'Healthy', detail: 'Nothing needs attention right now.', praise }
  }

  res.json({ generatedAt: new Date().toISOString(), summary, items, limits: LIMITS })
})

export default router