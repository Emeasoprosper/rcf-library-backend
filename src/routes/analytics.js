// routes/analytics.js
import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js' // adjust import if your auth middleware exports differently

const router = Router()

// Below this many views in the chosen window, a resource isn't considered
// "genuinely popular" yet — it just hasn't had enough traffic to mean
// anything. Tune this once you have real traffic data; 3 is a sane floor
// for a young library.
const MIN_VIEWS_TO_COUNT_AS_POPULAR = 3

// =========================================================
// POST /api/analytics/resources/:id/view
// =========================================================
// Call this when a resource detail page opens (not on every card
// hover/click — just when the user actually lands on the resource).
// Works for logged-out users too (user_id stays null) so anonymous
// traffic still counts toward trending/popular rankings.
router.post('/resources/:id/view', async (req, res) => {
  const resourceId = Number(req.params.id)
  if (!Number.isInteger(resourceId)) return res.status(400).json({ error: 'Invalid resource id' })

  const userId = req.user?.id || null // populate if you have optional-auth middleware; else stays null

  try {
    await query('INSERT INTO resource_views (resource_id, user_id) VALUES ($1, $2)', [resourceId, userId])
    await query('UPDATE resources SET view_count = view_count + 1 WHERE id = $1', [resourceId])
    res.status(204).end()
  } catch (err) {
    console.error('Failed to log resource view:', err)
    res.status(500).json({ error: 'Failed to log view' })
  }
})

// =========================================================
// GET /api/analytics/resources/frequently-viewed?window=7d&limit=10
// =========================================================
// window: 7d | 30d | all
//
// Cold-start handling: if the genuinely-popular set (views >= threshold)
// doesn't fill the requested limit, backfill with recently-added
// resources not already in the list. The response includes a `basis`
// field per item so the frontend can label them differently if it wants
// ("Popular" vs "New") — but it's safe to render as one plain rail too.
//
// file_type + thumbnail_status added to every SELECT below (previously
// missing) so the frontend's getMediaKind()/thumbnail-fallback logic has
// what it needs — without these, every card in this rail fell back to
// the generic document icon regardless of whether it was a video, audio
// file, or book.
router.get('/resources/frequently-viewed', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50)
  const windowParam = req.query.window || '7d'
  const intervalMap = { '7d': '7 days', '30d': '30 days' }
  const interval = intervalMap[windowParam]

  try {
    let popular
    if (interval) {
      const result = await query(
        `SELECT r.id, r.title, r.author, r.thumbnail_url, r.thumbnail_status, r.file_type,
                COUNT(v.id) AS recent_views
         FROM resource_views v
         JOIN resources r ON r.id = v.resource_id
         WHERE v.viewed_at > now() - $1::interval
         GROUP BY r.id
         HAVING COUNT(v.id) >= $2
         ORDER BY recent_views DESC
         LIMIT $3`,
        [interval, MIN_VIEWS_TO_COUNT_AS_POPULAR, limit]
      )
      popular = result.rows
    } else {
      const result = await query(
        `SELECT id, title, author, thumbnail_url, thumbnail_status, file_type, view_count AS recent_views
         FROM resources
         WHERE view_count >= $1
         ORDER BY view_count DESC
         LIMIT $2`,
        [MIN_VIEWS_TO_COUNT_AS_POPULAR, limit]
      )
      popular = result.rows
    }

    const withBasis = popular.map((r) => ({ ...r, basis: 'popular' }))

    if (withBasis.length >= limit) {
      return res.json(withBasis)
    }

    // Backfill with recently added, excluding anything already picked.
    const excludeIds = withBasis.map((r) => r.id)
    const needed = limit - withBasis.length
    const backfillResult = await query(
      `SELECT id, title, author, thumbnail_url, thumbnail_status, file_type, view_count AS recent_views
       FROM resources
       WHERE ($1::int[] = '{}' OR id != ALL($1::int[]))
       ORDER BY created_at DESC
       LIMIT $2`,
      [excludeIds, needed]
    )
    const backfill = backfillResult.rows.map((r) => ({ ...r, basis: 'new' }))

    res.json([...withBasis, ...backfill])
  } catch (err) {
    console.error('Failed to fetch frequently viewed:', err)
    res.status(500).json({ error: 'Failed to fetch frequently viewed resources' })
  }
})

// =========================================================
// GET /api/analytics/resources/:id/similar?limit=6
// =========================================================
// "You May Like" — primary signal is same resource_type, ranked by
// popularity. If that doesn't fill the limit (small library, niche
// type), backfill with recently-added resources of any type so the
// rail never looks sparse or empty. `basis` tells the frontend which
// tier each item came from, in case you want a "Related" vs "You May
// Also Like" heading split later.
router.get('/resources/:id/similar', async (req, res) => {
  const resourceId = Number(req.params.id)
  const limit = Math.min(Number(req.query.limit) || 6, 20)
  if (!Number.isInteger(resourceId)) return res.status(400).json({ error: 'Invalid resource id' })

  try {
    const sameTypeResult = await query(
      `SELECT r2.id, r2.title, r2.author, r2.thumbnail_url
       FROM resources r1
       JOIN resources r2 ON r2.resource_type_id = r1.resource_type_id AND r2.id != r1.id
       WHERE r1.id = $1
       ORDER BY r2.view_count DESC
       LIMIT $2`,
      [resourceId, limit]
    )
    const sameType = sameTypeResult.rows.map((r) => ({ ...r, basis: 'related' }))

    if (sameType.length >= limit) {
      return res.json(sameType)
    }

    const excludeIds = [resourceId, ...sameType.map((r) => r.id)]
    const needed = limit - sameType.length
    const backfillResult = await query(
      `SELECT id, title, author, thumbnail_url
       FROM resources
       WHERE id != ALL($1::int[])
       ORDER BY created_at DESC
       LIMIT $2`,
      [excludeIds, needed]
    )
    const backfill = backfillResult.rows.map((r) => ({ ...r, basis: 'new' }))

    res.json([...sameType, ...backfill])
  } catch (err) {
    console.error('Failed to fetch similar resources:', err)
    res.status(500).json({ error: 'Failed to fetch similar resources' })
  }
})

// =========================================================
// GET /api/analytics/recommended  (requires auth)
// =========================================================
// "For You" — three-tier fallback so a logged-in user never gets an
// empty rail:
//   1. Personalized: resource_types the user has actually viewed before,
//      ranked by how often they viewed that type, excluding items they've
//      already seen.
//   2. Trending backfill: if tier 1 doesn't fill the limit (new user, or
//      narrow viewing history), fill in with resources that are
//      genuinely popular right now, still excluding already-viewed items.
//   3. Recently added backfill: final fallback if the library itself
//      doesn't have enough trending volume yet.
router.get('/recommended', requireAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 30)
  const userId = req.user.id

  try {
    const viewedResult = await query(
      `SELECT DISTINCT resource_id FROM resource_views WHERE user_id = $1`,
      [userId]
    )
    const viewedIds = viewedResult.rows.map((r) => r.resource_id)

    const personalizedResult = await query(
      `WITH recent AS (
         SELECT resource_id FROM resource_views
         WHERE user_id = $1
         ORDER BY viewed_at DESC
         LIMIT 20
       ),
       preferred_types AS (
         SELECT r.resource_type_id, COUNT(*) AS weight
         FROM recent rv
         JOIN resources r ON r.id = rv.resource_id
         GROUP BY r.resource_type_id
       )
       SELECT r.id, r.title, r.author, r.thumbnail_url
       FROM resources r
       JOIN preferred_types pt ON pt.resource_type_id = r.resource_type_id
       WHERE r.id != ALL($2::int[])
       ORDER BY pt.weight DESC, r.view_count DESC
       LIMIT $3`,
      [userId, viewedIds.length ? viewedIds : [0], limit]
    )
    const personalized = personalizedResult.rows.map((r) => ({ ...r, basis: 'for_you' }))

    if (personalized.length >= limit) {
      return res.json(personalized)
    }

    const excludeAfterTier1 = [...viewedIds, ...personalized.map((r) => r.id)]
    const neededAfterTier1 = limit - personalized.length

    const trendingResult = await query(
      `SELECT id, title, author, thumbnail_url
       FROM resources
       WHERE id != ALL($1::int[]) AND view_count >= $2
       ORDER BY view_count DESC
       LIMIT $3`,
      [excludeAfterTier1.length ? excludeAfterTier1 : [0], MIN_VIEWS_TO_COUNT_AS_POPULAR, neededAfterTier1]
    )
    const trending = trendingResult.rows.map((r) => ({ ...r, basis: 'trending' }))

    const combined = [...personalized, ...trending]
    if (combined.length >= limit) {
      return res.json(combined)
    }

    const excludeAfterTier2 = [...excludeAfterTier1, ...trending.map((r) => r.id)]
    const neededAfterTier2 = limit - combined.length

    const newResult = await query(
      `SELECT id, title, author, thumbnail_url
       FROM resources
       WHERE id != ALL($1::int[])
       ORDER BY created_at DESC
       LIMIT $2`,
      [excludeAfterTier2.length ? excludeAfterTier2 : [0], neededAfterTier2]
    )
    const newest = newResult.rows.map((r) => ({ ...r, basis: 'new' }))

    res.json([...combined, ...newest])
  } catch (err) {
    console.error('Failed to fetch recommendations:', err)
    res.status(500).json({ error: 'Failed to fetch recommendations' })
  }
})

export default router