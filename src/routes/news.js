// RCFMOUAULIBRARYreact/rcf-library-backend/src/routes/news.js
import { Router } from 'express'
import { query } from '../db/pool.js'
import { getCachedExternalNews } from '../services/newsService.js'
import { streamFromStorage } from '../services/storage.js'

const router = Router()

// GET /news — recent admin-posted content (both 'news' AND 'announcement'
// types) + cached external items. Schedule-aware (see original comments).
router.get('/', async (req, res) => {
  const [adminResult, external] = await Promise.all([
    query(
      `SELECT id, title, message, attachment_url, attachment_mime, type,
              popup_style, hidden_detail, link_url, created_at
       FROM announcements
       WHERE type IN ('news', 'announcement')
         AND (starts_at IS NULL OR starts_at <= now())
         AND (ends_at IS NULL OR ends_at >= now())
         AND (
           daily_start_time IS NULL OR daily_end_time IS NULL
           OR now()::time BETWEEN daily_start_time AND daily_end_time
         )
       ORDER BY created_at DESC
       LIMIT 10`
    ),
    getCachedExternalNews(),
  ])
  res.json({
    adminNews: adminResult.rows,
    external: external.items || [],
    externalFetchedAt: external.fetchedAt,
  })
})

// GET /news/:id — single item, for the dedicated "read full detail" page
// (NewsDetail.jsx). Same schedule-window filter as the list, so a direct
// link to an expired item correctly 404s instead of showing stale content.
// No auth required — same public-content reasoning as GET /news.
router.get('/:id', async (req, res) => {
  const result = await query(
    `SELECT id, title, message, attachment_url, attachment_mime, type,
            popup_style, hidden_detail, link_url, created_at
     FROM announcements
     WHERE id = $1
       AND type IN ('news', 'announcement')
       AND (starts_at IS NULL OR starts_at <= now())
       AND (ends_at IS NULL OR ends_at >= now())
       AND (
         daily_start_time IS NULL OR daily_end_time IS NULL
         OR now()::time BETWEEN daily_start_time AND daily_end_time
       )`,
    [req.params.id]
  )
  if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' })
  res.json(result.rows[0])
})

// GET /news/attachment/:fileId — unchanged, streams from Drive.
router.get('/attachment/:fileId', async (req, res) => {
  const { data, mimeType } = await streamFromStorage(req.params.fileId)
  res.setHeader('Content-Type', mimeType || 'image/jpeg')
  res.setHeader('Cache-Control', 'public, max-age=86400')
  data.pipe(res)
})

export default router