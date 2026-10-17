// RCFMOUAULIBRARYreact/rcf-library-backend/src/routes/news.js
import { Router } from 'express'
import { query } from '../db/pool.js'
import { getCachedExternalNews } from '../services/newsService.js'
import { streamFromStorage, downloadFromStorage } from '../services/storage.js'

const router = Router()

// Turns the stored Drive file id into a playable URL on this API.
function withMusicUrl(req, row) {
  const { music_file_id: musicFileId, ...rest } = row
  return {
    ...rest,
    music_url: musicFileId ? `${req.protocol}://${req.get('host')}/api/news/music/${musicFileId}` : null,
  }
}

// GET /news — recent admin-posted content (both 'news' AND 'announcement'
// types) + cached external items. Schedule-aware.
router.get('/', async (req, res) => {
  const [adminResult, external] = await Promise.all([
    query(
      `SELECT id, title, message, attachment_url, attachment_mime, type,
              popup_style, hidden_detail, link_url, music_file_id, music_loop, created_at
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
    adminNews: adminResult.rows.map((row) => withMusicUrl(req, row)),
    external: external.items || [],
    externalFetchedAt: external.fetchedAt,
  })
})

// A track is small, so the last few are kept in memory. Browsers ask for
// audio in several byte-range pieces, and this avoids a Drive download
// for each piece.
const MUSIC_CACHE_MAX = 3
const musicCache = new Map()

async function loadMusic(fileId) {
  const meta = await query(`SELECT music_mime FROM announcements WHERE music_file_id = $1 LIMIT 1`, [fileId])
  if (meta.rows.length === 0) return null

  let buffer = musicCache.get(fileId)
  if (!buffer) {
    buffer = await downloadFromStorage(fileId)
    if (musicCache.size >= MUSIC_CACHE_MAX) musicCache.delete(musicCache.keys().next().value)
    musicCache.set(fileId, buffer)
  }
  return { buffer, mime: meta.rows[0].music_mime || 'audio/mpeg' }
}

// GET /news/music/:fileId — only serves files that an announcement uses.
router.get('/music/:fileId', async (req, res) => {
  let track
  try {
    track = await loadMusic(req.params.fileId)
  } catch (err) {
    console.error(`Failed to load announcement music ${req.params.fileId}:`, err.message)
    return res.status(502).json({ error: 'Failed to load music' })
  }
  if (!track) return res.status(404).json({ error: 'Not found' })

  const { buffer, mime } = track
  const total = buffer.length
  res.setHeader('Content-Type', mime)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'public, max-age=86400')

  const rangeHeader = req.headers.range
  if (!rangeHeader) {
    res.setHeader('Content-Length', total)
    return res.status(200).send(buffer)
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
  if (!match || (!match[1] && !match[2])) {
    res.setHeader('Content-Range', `bytes */${total}`)
    return res.status(416).end()
  }
  const start = match[1] ? parseInt(match[1], 10) : total - parseInt(match[2], 10)
  const end = match[2] && match[1] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1
  if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start > end || end >= total) {
    res.setHeader('Content-Range', `bytes */${total}`)
    return res.status(416).end()
  }

  const chunk = buffer.subarray(start, end + 1)
  res.status(206)
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`)
  res.setHeader('Content-Length', chunk.length)
  res.send(chunk)
})

// GET /news/attachment/:fileId — unchanged, streams from Drive.
router.get('/attachment/:fileId', async (req, res) => {
  const { data, mimeType } = await streamFromStorage(req.params.fileId)
  res.setHeader('Content-Type', mimeType || 'image/jpeg')
  res.setHeader('Cache-Control', 'public, max-age=86400')
  data.pipe(res)
})

// GET /news/:id — single item, for the dedicated "read full detail" page.
router.get('/:id', async (req, res) => {
  const result = await query(
    `SELECT id, title, message, attachment_url, attachment_mime, type,
            popup_style, hidden_detail, link_url, music_file_id, music_loop, created_at
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
  res.json(withMusicUrl(req, result.rows[0]))
})

export default router